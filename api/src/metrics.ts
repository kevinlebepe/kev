import type { Db } from './db.js';

// Metrics in the Prometheus text format (spec section 21): request rate,
// errors and latency by route, database connections, queue depths, storage
// uploads, live video sessions and exam activity. Counters are per instance;
// the monitoring system adds them up across instances.

/** Latency buckets, in seconds. */
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}

const requests = new Map<string, Series>();
let uploadedPieces = 0;
let uploadedBytes = 0;

/** Label values are quoted and escaped as the format requires. */
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function recordRequest(method: string, route: string, status: number, seconds: number): void {
  const key = `${method}\u0000${route}\u0000${status}`;
  let s = requests.get(key);
  if (!s) {
    s = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    requests.set(key, s);
  }
  s.count += 1;
  s.sum += seconds;
  BUCKETS.forEach((b, i) => {
    if (seconds <= b) s.buckets[i]! += 1;
  });
}

export function recordUpload(bytes: number): void {
  uploadedPieces += 1;
  uploadedBytes += bytes;
}

/** For tests. */
export function resetMetrics(): void {
  requests.clear();
  uploadedPieces = 0;
  uploadedBytes = 0;
}

export async function renderMetrics(db: Db): Promise<string> {
  const out: string[] = [];
  const help = (name: string, type: string, text: string) => out.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);

  help('examguard_http_requests_total', 'counter', 'HTTP requests by method, route and status.');
  for (const [key, s] of requests) {
    const [method, route, status] = key.split('\u0000') as [string, string, string];
    out.push(`examguard_http_requests_total{method="${esc(method)}",route="${esc(route)}",status="${status}"} ${s.count}`);
  }
  help('examguard_http_request_duration_seconds', 'histogram', 'HTTP request latency by method and route.');
  const byRoute = new Map<string, Series>();
  for (const [key, s] of requests) {
    const [method, route] = key.split('\u0000') as [string, string];
    const k = `${method}\u0000${route}`;
    const t = byRoute.get(k) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    t.count += s.count;
    t.sum += s.sum;
    s.buckets.forEach((n, i) => (t.buckets[i]! += n));
    byRoute.set(k, t);
  }
  for (const [k, s] of byRoute) {
    const [method, route] = k.split('\u0000') as [string, string];
    const labels = `method="${esc(method)}",route="${esc(route)}"`;
    BUCKETS.forEach((b, i) => out.push(`examguard_http_request_duration_seconds_bucket{${labels},le="${b}"} ${s.buckets[i]}`));
    out.push(`examguard_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${s.count}`);
    out.push(`examguard_http_request_duration_seconds_sum{${labels}} ${s.sum.toFixed(6)}`);
    out.push(`examguard_http_request_duration_seconds_count{${labels}} ${s.count}`);
  }

  help('examguard_db_connections', 'gauge', 'Database pool connections on this instance.');
  out.push(`examguard_db_connections{state="total"} ${db.totalCount}`, `examguard_db_connections{state="idle"} ${db.idleCount}`, `examguard_db_connections{state="waiting"} ${db.waitingCount}`);

  help('examguard_recording_pieces_uploaded_total', 'counter', 'Recording pieces received by this instance.');
  out.push(`examguard_recording_pieces_uploaded_total ${uploadedPieces}`);
  help('examguard_recording_bytes_uploaded_total', 'counter', 'Recording bytes received by this instance.');
  out.push(`examguard_recording_bytes_uploaded_total ${uploadedBytes}`);

  // Platform wide figures, read from the database.
  try {
    const { rows } = await db.query<Record<string, string | number | null>>(
      `SELECT
         (SELECT count(*) FROM notifications WHERE channel = 'email' AND sent_at IS NULL AND failed_at IS NULL) AS email_queued,
         (SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0) FROM notifications WHERE channel = 'email' AND sent_at IS NULL AND failed_at IS NULL) AS email_oldest,
         (SELECT count(*) FROM webhook_deliveries WHERE delivered_at IS NULL AND failed_at IS NULL) AS webhooks_queued,
         (SELECT count(*) FROM submissions WHERE status = 'evidence_pending') AS evidence_pending,
         (SELECT count(*) FROM attempts WHERE status = 'active') AS attempts_active,
         (SELECT count(*) FROM attempts WHERE status = 'active' AND last_seen_at < now() - interval '60 seconds') AS attempts_offline,
         (SELECT count(*) FROM live_calls WHERE status = 'open') AS live_calls_open,
         (SELECT count(*) FROM sessions WHERE status = 'open') AS sessions_open`,
    );
    const r = rows[0]!;
    const gauge = (name: string, text: string, value: unknown) => {
      help(name, 'gauge', text);
      out.push(`${name} ${Number(value ?? 0)}`);
    };
    gauge('examguard_email_queue_depth', 'Emails waiting to be sent.', r.email_queued);
    gauge('examguard_email_queue_oldest_seconds', 'Age of the oldest email waiting.', Math.round(Number(r.email_oldest)));
    gauge('examguard_webhook_queue_depth', 'Webhook calls waiting to be delivered.', r.webhooks_queued);
    gauge('examguard_submissions_evidence_pending', 'Submissions still waiting for recordings.', r.evidence_pending);
    gauge('examguard_attempts_active', 'Exams being sat now.', r.attempts_active);
    gauge('examguard_attempts_offline', 'Exams being sat whose device has not checked in for a minute.', r.attempts_offline);
    gauge('examguard_webrtc_sessions_open', 'Live video or voice calls open.', r.live_calls_open);
    gauge('examguard_sessions_open', 'Exam sessions open.', r.sessions_open);

    const { rows: jobs } = await db.query<{ name: string; age: number | null; failing: boolean }>(
      `SELECT name, extract(epoch FROM now() - coalesce(last_finished_at, last_started_at))::int AS age,
              last_error_at IS NOT NULL AND last_error_at > coalesce(last_finished_at, '-infinity') AS failing
         FROM job_runs ORDER BY name`,
    );
    help('examguard_job_last_run_seconds', 'gauge', 'Seconds since each background job last finished.');
    for (const j of jobs) out.push(`examguard_job_last_run_seconds{job="${esc(j.name)}"} ${j.age ?? -1}`);
    help('examguard_job_failing', 'gauge', 'Whether a background job failed on its last run.');
    for (const j of jobs) out.push(`examguard_job_failing{job="${esc(j.name)}"} ${j.failing ? 1 : 0}`);
    help('examguard_component_up', 'gauge', 'Last health check of each part: 1 working, 0.5 limited, 0 not working.');
    const { rows: comps } = await db.query<{ component: string; status: string }>('SELECT component, status FROM service_status ORDER BY component');
    for (const c of comps) out.push(`examguard_component_up{component="${esc(c.component)}"} ${c.status === 'down' ? 0 : c.status === 'degraded' ? 0.5 : 1}`);
  } catch {
    help('examguard_database_up', 'gauge', 'Whether the database answered.');
    out.push('examguard_database_up 0');
    return out.join('\n') + '\n';
  }
  help('examguard_database_up', 'gauge', 'Whether the database answered.');
  out.push('examguard_database_up 1');
  return out.join('\n') + '\n';
}
