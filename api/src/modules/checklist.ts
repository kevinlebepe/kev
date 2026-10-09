import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { authorize, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR } from '../allocation.js';
import { examConfig } from '../examConfig.js';
import { idParams, parse } from '../validation.js';

// The exam event checklist (spec section 21), for 24 to 72 hours before a
// session and for the day itself. Most items are worked out from the data;
// the rest are confirmed by a person, and who confirmed them is recorded.

type State = 'ok' | 'warn' | 'todo';
interface Item {
  key: string;
  label: string;
  state: State;
  detail: string;
  manual: boolean;
  doneBy?: string | null;
  doneAt?: Date | null;
}

export const MANUAL_ITEMS: Record<string, string> = {
  backups_verified: 'Database backups verified by a test restore',
  monitoring_tested: 'Monitoring alerts tested and reaching the people on duty',
  support_contacts: 'Support contacts confirmed and shared with candidates',
  capacity_checked: 'Capacity checked for the number of candidates and recordings',
};
const itemParams = z.object({ id: z.uuid(), item: z.string().max(50) });
const itemBody = z.object({ done: z.boolean() });

export async function checklistRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;

  app.get('/sessions/:id/checklist', { preHandler: authorize('session:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query<{
      name: string;
      starts_at: Date;
      version: number;
      manifest_sha256: string;
      config: unknown;
      assigned: number;
      pending_people: number;
      ready: number;
      rostered: number;
      present_capacity: number;
    }>(
      `SELECT s.name, s.starts_at, v.version, v.manifest_sha256, v.manifest->'config' AS config,
              (SELECT count(*)::int FROM exam_assignments a WHERE a.session_id = s.id AND a.status <> 'revoked') AS assigned,
              (SELECT count(*)::int FROM candidates c WHERE c.organisation_id = s.organisation_id AND c.status IN ('invited', 'registered', 'pending_approval')) AS pending_people,
              (SELECT count(*)::int FROM exam_assignments a WHERE a.session_id = s.id AND a.status IN ('precheck_complete', 'active', 'submitted', 'completed')) AS ready,
              (SELECT count(*)::int FROM session_invigilators si JOIN invigilators i ON i.id = si.invigilator_id WHERE si.session_id = s.id AND i.status = 'active') AS rostered,
              (SELECT coalesce(sum(least(i.max_active, $3)), 0)::int FROM session_invigilators si JOIN invigilators i ON i.id = si.invigilator_id
                WHERE si.session_id = s.id AND i.status = 'active') AS present_capacity
         FROM sessions s JOIN exam_versions v ON v.id = s.exam_version_id
        WHERE s.id = $1 AND s.organisation_id = $2`,
      [id, auth.organisationId, PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR],
    );
    const s = rows[0];
    if (!s) throw notFound('Session');
    const cfg = examConfig.parse(s.config ?? {});
    const cap = Math.min(cfg.invigilation.maxCandidatesPerInvigilator, PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR);
    const needed = Math.ceil(s.assigned / cap);
    const items: Item[] = [];
    const add = (key: string, label: string, state: State, detail: string) => items.push({ key, label, state, detail, manual: false });

    add('roster', 'Candidate roster finalised', s.assigned === 0 ? 'todo' : 'ok', s.assigned === 0 ? 'Nobody is assigned yet.' : `${s.assigned} candidates assigned.${s.pending_people ? ` ${s.pending_people} people in the organisation still wait for invitation or approval.` : ''}`);
    add(
      'invigilators',
      'Invigilators assigned',
      !cfg.invigilation.required && s.rostered === 0 ? 'ok' : s.rostered === 0 ? 'todo' : Math.min(s.present_capacity, s.rostered * cap) < s.assigned ? 'warn' : 'ok',
      cfg.invigilation.required || s.rostered
        ? `${s.rostered} rostered; ${needed} needed for ${s.assigned} candidates at ${cap} each.`
        : 'This exam does not require invigilation.',
    );
    add('exam_version', 'Exam version locked', 'ok', `Version ${s.version} is signed and cannot change (SHA-256 ${s.manifest_sha256.slice(0, 12)}…).`);
    add(
      'device_checks',
      'Device checks available and passed',
      s.assigned === 0 ? 'todo' : s.ready === s.assigned ? 'ok' : 'warn',
      s.assigned === 0 ? 'Assign candidates first.' : `${s.ready} of ${s.assigned} candidates have passed the device check.`,
    );

    const { rows: sso } = await db.query<{ providers: number; recent: number }>(
      `SELECT (SELECT count(*)::int FROM identity_providers WHERE organisation_id = $1 AND enabled) AS providers,
              (SELECT count(*)::int FROM audit_logs WHERE organisation_id = $1 AND action = 'auth.sso' AND created_at > now() - interval '7 days') AS recent`,
      [auth.organisationId],
    );
    add(
      'sign_in',
      'Sign in and single sign on tested',
      sso[0]!.providers === 0 ? 'ok' : sso[0]!.recent > 0 ? 'ok' : 'warn',
      sso[0]!.providers === 0
        ? 'Candidates sign in with a password; there is no single sign on to test.'
        : sso[0]!.recent > 0
          ? `Single sign on worked ${sso[0]!.recent} times in the last 7 days.`
          : 'Nobody has signed in through single sign on in the last 7 days. Try it before the exam.',
    );

    const { rows: comps } = await db.query<{ component: string; status: string; message: string | null }>(
      `SELECT component, status, message FROM service_status WHERE component IN ('storage', 'email', 'media', 'database')`,
    );
    const comp = (name: string) => comps.find((c) => c.component === name);
    const fromHealth = (key: string, label: string, name: string, okText: string) => {
      const c = comp(name);
      add(key, label, !c ? 'warn' : c.status === 'ok' || c.status === 'off' ? 'ok' : 'warn', !c ? 'Not checked yet: the health monitor runs every minute.' : c.status === 'ok' ? okText : (c.message ?? c.status));
    };
    fromHealth('storage', 'Storage capacity and access checked', 'storage', 'Recording storage accepts and returns files.');
    const turn = config.iceServers.some((srv) => (Array.isArray(srv.urls) ? srv.urls : [srv.urls]).some((u) => /^turns?:/.test(u)));
    add('media', 'Live video relay (TURN) checked', turn ? 'ok' : 'warn', turn ? 'A TURN relay is configured.' : 'No TURN relay: live video may fail on strict networks.');
    fromHealth('email', 'Email reaching candidates', 'email', 'Email is being sent.');

    const { rows: done } = await db.query<{ item: string; done_by: string | null; done_at: Date }>(
      `SELECT sc.item, u.display_name AS done_by, sc.done_at FROM session_checklist sc LEFT JOIN users u ON u.id = sc.done_by WHERE sc.session_id = $1`,
      [id],
    );
    for (const [key, label] of Object.entries(MANUAL_ITEMS)) {
      const d = done.find((x) => x.item === key);
      items.push({ key, label, state: d ? 'ok' : 'todo', detail: d ? '' : 'Confirm when done.', manual: true, doneBy: d?.done_by ?? null, doneAt: d?.done_at ?? null });
    }
    return {
      sessionId: id,
      sessionName: s.name,
      startsAt: s.starts_at,
      ready: items.every((i) => i.state === 'ok'),
      items,
    };
  });

  app.put('/sessions/:id/checklist/:item', { preHandler: authorize('session:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id, item } = parse(itemParams, req.params);
    const { done } = parse(itemBody, req.body);
    if (!(item in MANUAL_ITEMS)) throw badRequest('That item is worked out automatically');
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query('SELECT 1 FROM sessions WHERE id = $1 AND organisation_id = $2', [id, auth.organisationId]);
      if (!rowCount) throw notFound('Session');
      if (done) {
        await tx.query(
          `INSERT INTO session_checklist (session_id, item, done_by) VALUES ($1, $2, $3)
           ON CONFLICT (session_id, item) DO UPDATE SET done_by = EXCLUDED.done_by, done_at = now()`,
          [id, item, auth.userId],
        );
      } else {
        await tx.query('DELETE FROM session_checklist WHERE session_id = $1 AND item = $2', [id, item]);
      }
      await audit(tx, { ...auditFrom(req), action: done ? 'checklist.done' : 'checklist.undone', targetType: 'session', targetId: id, data: { item } });
      return { item, done };
    });
  });
}
