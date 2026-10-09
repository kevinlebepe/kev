import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { notify } from './notifications.js';
import type { ObjectStore } from './storage.js';

// Service health (spec sections 5, 13, 17 and 21). Each part of the platform
// is checked and given a status; a monitor keeps the last known state in the
// database, shared by every instance, and emails the platform operators when
// something breaks and again when it recovers.

export type Status = 'ok' | 'degraded' | 'down' | 'off';
export interface Component {
  name: string;
  status: Status;
  /** Plain words for staff. */
  message: string;
  detail?: Record<string, unknown>;
}

const RANK: Record<Status, number> = { ok: 0, off: 0, degraded: 1, down: 2 };
export const worst = (list: Status[]): Status => list.reduce<Status>((w, s) => (RANK[s] > RANK[w] ? s : w), 'ok');

/** The parts of the platform shown on the status page, in order. */
export const COMPONENTS = ['api', 'database', 'storage', 'email', 'webhooks', 'workers', 'media', 'authentication'] as const;
export const COMPONENT_NAMES: Record<string, string> = {
  api: 'Exam service',
  database: 'Database',
  storage: 'Recording storage',
  email: 'Email',
  webhooks: 'Integrations',
  workers: 'Background work',
  media: 'Live video and voice',
  authentication: 'Sign in',
};

const startedAt = Date.now();
const instanceId = randomUUID().slice(0, 8);

/** The background jobs and how often they should run; used to spot one that has stalled. */
export const JOBS: Record<string, number> = {
  expiry: 30,
  failover: 30,
  reminders: 60,
  webhooks: 10,
  email: 10,
  retention: 3600,
  monitor: 60,
};

/**
 * Runs a background job and records when it ran and whether it failed, so
 * the health check can tell a stalled worker from a quiet one.
 */
export async function trackJob(db: Db, name: string, run: () => Promise<unknown>): Promise<void> {
  const interval = JOBS[name] ?? 60;
  try {
    await db.query(
      `INSERT INTO job_runs (name, interval_seconds, last_started_at) VALUES ($1, $2, now())
       ON CONFLICT (name) DO UPDATE SET last_started_at = now(), interval_seconds = EXCLUDED.interval_seconds`,
      [name, interval],
    );
  } catch {
    // Recording is best effort; the job itself matters more.
  }
  try {
    await run();
    await db.query('UPDATE job_runs SET last_finished_at = now() WHERE name = $1', [name]).catch(() => undefined);
  } catch (err) {
    await db
      .query('UPDATE job_runs SET last_error = $2, last_error_at = now() WHERE name = $1', [name, String((err as Error).message).slice(0, 500)])
      .catch(() => undefined);
    throw err;
  }
}

const storageCache = new WeakMap<ObjectStore, { at: number; component: Component }>();
/** Storage is probed with a real write, read and delete, at most once a minute per instance. */
const STORAGE_PROBE_MS = 60_000;

async function checkStorage(store: ObjectStore | undefined): Promise<Component> {
  if (!store) return { name: 'storage', status: 'off', message: 'No recording storage is configured on this instance.' };
  const cached = storageCache.get(store);
  if (cached && Date.now() - cached.at < STORAGE_PROBE_MS) return cached.component;
  const key = `health/${instanceId}`;
  const started = Date.now();
  let component: Component;
  try {
    await store.put(key, Buffer.from('ok'));
    const got = await store.get(key);
    if (!got) throw new Error('A file just written could not be read back');
    got.stream.resume();
    await store.delete(key);
    const ms = Date.now() - started;
    component =
      ms > 3000
        ? { name: 'storage', status: 'degraded', message: `Recording storage is slow (${ms} ms to write and read a test file).`, detail: { ms } }
        : { name: 'storage', status: 'ok', message: 'Recordings can be stored and read.', detail: { ms } };
  } catch (err) {
    component = { name: 'storage', status: 'down', message: `Recording storage is failing: ${(err as Error).message}`.slice(0, 300) };
  }
  storageCache.set(store, { at: Date.now(), component });
  return component;
}

/** Checks every part of the platform. Never throws: a failing check is reported as down. */
export async function checkHealth(db: Db, config: Config, store: ObjectStore | undefined): Promise<Component[]> {
  const out: Component[] = [
    {
      name: 'api',
      status: 'ok',
      message: 'This instance is answering.',
      detail: { instance: instanceId, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) },
    },
  ];

  const started = Date.now();
  let dbUp = true;
  try {
    await db.query('SELECT 1');
    const ms = Date.now() - started;
    const waiting = db.waitingCount;
    out.push({
      name: 'database',
      status: ms > 500 || waiting > 5 ? 'degraded' : 'ok',
      message: ms > 500 || waiting > 5 ? `The database is slow (${ms} ms, ${waiting} requests waiting).` : 'The database is answering.',
      detail: { ms, connections: db.totalCount, idle: db.idleCount, waiting },
    });
  } catch (err) {
    dbUp = false;
    out.push({ name: 'database', status: 'down', message: `The database cannot be reached: ${(err as Error).message}`.slice(0, 300) });
  }

  out.push(await checkStorage(store));

  if (!dbUp) {
    for (const name of ['email', 'webhooks', 'workers', 'authentication'])
      out.push({ name, status: 'down', message: 'Cannot be checked while the database is unreachable.' });
  } else {
    try {
      const { rows: mail } = await db.query<{ queued: number; oldest: number | null; failed: number }>(
        `SELECT count(*) FILTER (WHERE sent_at IS NULL AND failed_at IS NULL)::int AS queued,
                extract(epoch FROM now() - min(created_at) FILTER (WHERE sent_at IS NULL AND failed_at IS NULL))::int AS oldest,
                count(*) FILTER (WHERE failed_at > now() - interval '1 hour')::int AS failed
           FROM notifications WHERE channel = 'email'`,
      );
      const m = mail[0]!;
      if (!config.smtpUrl && process.env.NODE_ENV === 'production') {
        // A setup gap rather than an outage: invitations and reminders are not sent until SMTP_URL is set.
        out.push({ name: 'email', status: 'degraded', message: 'No mail server is set up (SMTP_URL), so no email is sent: invitations, reminders and results notices will not arrive.', detail: m });
      } else if ((m.oldest ?? 0) > 15 * 60 || m.failed > 0) {
        out.push({
          name: 'email',
          status: 'degraded',
          message: `${m.queued} emails waiting${m.oldest ? `, the oldest for ${Math.round(m.oldest / 60)} minutes` : ''}; ${m.failed} failed in the last hour.`,
          detail: m,
        });
      } else {
        out.push({ name: 'email', status: 'ok', message: config.smtpUrl ? 'Email is being sent.' : 'Development: emails are printed to the log.', detail: m });
      }

      const { rows: hooks } = await db.query<{ due: number; oldest: number | null; failed: number }>(
        `SELECT count(*) FILTER (WHERE delivered_at IS NULL AND failed_at IS NULL)::int AS due,
                extract(epoch FROM now() - min(created_at) FILTER (WHERE delivered_at IS NULL AND failed_at IS NULL))::int AS oldest,
                count(*) FILTER (WHERE failed_at > now() - interval '1 hour')::int AS failed
           FROM webhook_deliveries`,
      );
      const w = hooks[0]!;
      out.push(
        (w.oldest ?? 0) > 30 * 60
          ? { name: 'webhooks', status: 'degraded', message: `${w.due} webhook calls waiting, the oldest for ${Math.round(w.oldest! / 60)} minutes.`, detail: w }
          : { name: 'webhooks', status: 'ok', message: 'Webhooks are being delivered.', detail: w },
      );

      const { rows: jobs } = await db.query<{ name: string; late: boolean; failing: boolean; last_error: string | null }>(
        `SELECT name, last_error,
                coalesce(last_finished_at, last_started_at) < now() - make_interval(secs => interval_seconds * 3 + 60) AS late,
                last_error_at IS NOT NULL AND last_error_at > coalesce(last_finished_at, '-infinity') AS failing
           FROM job_runs ORDER BY name`,
      );
      const late = jobs.filter((j) => j.late).map((j) => j.name);
      const failing = jobs.filter((j) => j.failing).map((j) => j.name);
      out.push(
        late.length || failing.length
          ? {
              name: 'workers',
              status: 'degraded',
              message: [late.length && `Not run recently: ${late.join(', ')}.`, failing.length && `Failing: ${failing.join(', ')}.`].filter(Boolean).join(' '),
              detail: { late, failing },
            }
          : { name: 'workers', status: 'ok', message: jobs.length ? 'Background work is running.' : 'No background work has run yet.', detail: { jobs: jobs.length } },
      );

      const { rows: auth } = await db.query<{ failed: number; ok: number }>(
        `SELECT count(*) FILTER (WHERE action IN ('auth.login_failed', 'auth.locked'))::int AS failed,
                count(*) FILTER (WHERE action = 'auth.login')::int AS ok
           FROM audit_logs WHERE created_at > now() - interval '10 minutes' AND action LIKE 'auth.%'`,
      );
      const a = auth[0]!;
      out.push(
        a.failed >= 50 && a.failed > a.ok * 2
          ? { name: 'authentication', status: 'degraded', message: `Many failed sign ins: ${a.failed} in the last 10 minutes, against ${a.ok} that worked.`, detail: a }
          : { name: 'authentication', status: 'ok', message: 'Sign in is working.', detail: a },
      );
    } catch (err) {
      out.push({ name: 'workers', status: 'down', message: `Health queries failed: ${(err as Error).message}`.slice(0, 300) });
    }
  }

  const urls = config.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
  const turn = urls.some((u) => /^turns?:/.test(u));
  out.push(
    turn
      ? { name: 'media', status: 'ok', message: 'Live video can connect, through a relay when a network blocks direct connections.', detail: { servers: urls.length } }
      : {
          name: 'media',
          status: 'degraded',
          message: 'No TURN relay is configured: live video works on most networks, but not on strict ones.',
          detail: { servers: urls.length },
        },
  );
  return out;
}

/**
 * Runs the checks and stores the result. On a change for the worse, or a
 * recovery, platform operators get an email (spec section 20, service
 * incident). Only one instance at a time does this.
 */
export async function monitorHealth(db: Db, config: Config, store: ObjectStore | undefined): Promise<Component[] | null> {
  const client = await db.connect();
  try {
    const { rows: lock } = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('examguard.health')) AS ok`);
    if (!lock[0]!.ok) return null;
    try {
      const components = await checkHealth(db, config, store);
      const { rows: before } = await client.query<{ component: string; status: Status }>('SELECT component, status FROM service_status');
      const previous = new Map(before.map((r) => [r.component, r.status]));
      const changes: string[] = [];
      for (const c of components) {
        const was = previous.get(c.name);
        await client.query(
          `INSERT INTO service_status (component, status, message) VALUES ($1, $2, $3)
           ON CONFLICT (component) DO UPDATE
              SET changed_at = CASE WHEN service_status.status <> EXCLUDED.status THEN now() ELSE service_status.changed_at END,
                  status = EXCLUDED.status, message = EXCLUDED.message, checked_at = now()`,
          [c.name, c.status, c.message],
        );
        // A part that was never checked before starts out quietly.
        if (was === undefined || was === c.status) continue;
        if (RANK[c.status] > RANK[was]) changes.push(`${COMPONENT_NAMES[c.name] ?? c.name} is ${c.status === 'down' ? 'down' : 'degraded'}: ${c.message}`);
        else if (RANK[c.status] < RANK[was]) changes.push(`${COMPONENT_NAMES[c.name] ?? c.name} has recovered.`);
      }
      if (changes.length) {
        const { rows: operators } = await client.query<{ id: string }>(`SELECT id FROM users WHERE platform_role = 'super_admin'`);
        for (const o of operators) {
          await notify(client, { organisationId: null, kind: 'service_incident', channel: 'email', recipientUserId: o.id, payload: { message: changes.join('\n') } });
        }
      }
      return components;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('examguard.health'))`);
    }
  } finally {
    client.release();
  }
}
