import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../context.js';
import { authorize, requireOrg } from '../auth/context.js';
import { checkHealth, COMPONENT_NAMES, COMPONENTS, type Component, type Status, worst } from '../health.js';

/** An attempt that has not checked in for this long counts as offline. */
const OFFLINE_SECONDS = 60;

const PUBLIC_TEXT: Record<Status, string> = { ok: 'Working', off: 'Working', degraded: 'Slower or limited', down: 'Not working' };

export interface Incident {
  /** Where the problem lies (spec section 17, incident mode). */
  area: 'service' | 'widespread' | 'regional' | 'candidate' | 'authentication' | 'storage' | 'live_media';
  severity: 'high' | 'warning' | 'info';
  message: string;
  sessionId?: string;
}

export async function systemRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;

  // Public status page (spec sections 3 and 21): candidates and staff can see
  // before a major exam whether the service is working. It shows no data about
  // any organisation, and no internal detail.
  app.get('/status', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => {
    const { rows } = await db
      .query<{ component: string; status: Status; changed_at: Date; checked_at: Date }>('SELECT component, status, changed_at, checked_at FROM service_status')
      .catch(() => ({ rows: [] as { component: string; status: Status; changed_at: Date; checked_at: Date }[] }));
    let byName = new Map(rows.map((r) => [r.component, r]));
    // Before the monitor's first run, or if its view is stale, check now.
    const stale = rows.length === 0 || rows.some((r) => Date.now() - r.checked_at.getTime() > 5 * 60_000);
    if (stale) {
      const live = await checkHealth(db, config, deps.store);
      byName = new Map(live.map((c) => [c.name, { component: c.name, status: c.status, changed_at: new Date(), checked_at: new Date() }]));
    }
    const components = COMPONENTS.filter((n) => byName.has(n)).map((n) => {
      const r = byName.get(n)!;
      return { name: n, label: COMPONENT_NAMES[n], status: r.status === 'off' ? 'ok' : r.status, text: PUBLIC_TEXT[r.status], since: r.changed_at };
    });
    const overall = worst(components.map((c) => c.status as Status));
    return {
      status: overall,
      text: overall === 'ok' ? 'All systems are working.' : overall === 'degraded' ? 'Some parts are slower or limited.' : 'Part of the service is not working.',
      components,
      checkedAt: new Date(Math.min(...[...byName.values()].map((r) => r.checked_at.getTime()))),
    };
  });

  // The full picture for staff (spec sections 5 and 17): each component with
  // its detail, and incidents for this organisation's open sessions, sorted
  // into whether a problem is one candidate's, a group's, or the service's.
  app.get('/system/health', { preHandler: authorize('report:view') }, async (req) => {
    const auth = requireOrg(req);
    const components = await checkHealth(db, config, deps.store);
    const status = (name: string) => components.find((c) => c.name === name)?.status ?? 'ok';

    const { rows: sessions } = await db.query<{ id: string; name: string; sitting: number; offline: number; recent: number; evidence: number }>(
      `SELECT s.id, s.name,
              count(at.id) FILTER (WHERE at.status = 'active')::int AS sitting,
              count(at.id) FILTER (WHERE at.status = 'active' AND at.last_seen_at < now() - make_interval(secs => $2))::int AS offline,
              (SELECT count(*)::int FROM events e JOIN attempts a2 ON a2.id = e.attempt_id JOIN exam_assignments ea ON ea.id = a2.assignment_id
                WHERE ea.session_id = s.id AND e.severity = 'high' AND e.occurred_at > now() - interval '15 minutes') AS recent,
              (SELECT count(*)::int FROM submissions sub JOIN attempts a3 ON a3.id = sub.attempt_id JOIN exam_assignments eb ON eb.id = a3.assignment_id
                WHERE eb.session_id = s.id AND sub.status = 'evidence_pending') AS evidence
         FROM sessions s
         LEFT JOIN exam_assignments a ON a.session_id = s.id
         LEFT JOIN attempts at ON at.assignment_id = a.id
        WHERE s.organisation_id = $1 AND s.status = 'open'
        GROUP BY s.id, s.name
        ORDER BY s.starts_at`,
      [auth.organisationId, OFFLINE_SECONDS],
    );
    const sitting = sessions.reduce((n, s) => n + s.sitting, 0);
    const offline = sessions.reduce((n, s) => n + s.offline, 0);
    const incidents: Incident[] = [];

    for (const c of components) {
      if (['api', 'database'].includes(c.name) && c.status === 'down') {
        incidents.push({ area: 'service', severity: 'high', message: `${COMPONENT_NAMES[c.name]} is not working. This affects every candidate; answers stay on their devices until it returns.` });
      }
    }
    if (status('storage') !== 'ok' && status('storage') !== 'off') {
      const waiting = sessions.reduce((n, s) => n + s.evidence, 0);
      incidents.push({
        area: 'storage',
        severity: status('storage') === 'down' ? 'high' : 'warning',
        message: `Recording storage is ${status('storage') === 'down' ? 'failing' : 'slow'}. Candidates' devices keep the recordings and retry; ${waiting} submissions are waiting for recordings.`,
      });
    }
    if (status('authentication') === 'degraded') {
      incidents.push({ area: 'authentication', severity: 'warning', message: components.find((c) => c.name === 'authentication')!.message });
    }
    if (status('media') === 'down') {
      incidents.push({ area: 'live_media', severity: 'warning', message: components.find((c) => c.name === 'media')!.message });
    }

    // Many candidates dropping at once points away from their own devices.
    const widespread = offline >= 3 && offline >= sitting * 0.3;
    if (widespread) {
      incidents.push({
        area: 'widespread',
        severity: 'high',
        message: `${offline} of ${sitting} candidates sitting are offline at the same time. This points to a network or service problem rather than their own devices.`,
      });
    } else {
      for (const s of sessions) {
        if (s.offline >= 3 && s.offline >= s.sitting * 0.5) {
          incidents.push({
            area: 'regional',
            severity: 'high',
            sessionId: s.id,
            message: `${s.offline} of ${s.sitting} candidates in ${s.name} are offline, while other sessions are not affected. The problem may be at one venue or in one area.`,
          });
        } else if (s.offline > 0) {
          incidents.push({
            area: 'candidate',
            severity: 'warning',
            sessionId: s.id,
            message: `${s.offline} candidate${s.offline > 1 ? 's' : ''} in ${s.name} ${s.offline > 1 ? 'are' : 'is'} offline. Their answers are kept on their devices.`,
          });
        }
      }
    }

    return {
      status: worst(components.map((c) => c.status)),
      components: components.map((c: Component) => ({ ...c, label: COMPONENT_NAMES[c.name] ?? c.name })),
      sessions,
      sitting,
      offline,
      recentSeriousEvents: sessions.reduce((n, s) => n + s.recent, 0),
      incidents,
    };
  });
}
