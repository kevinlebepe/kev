import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { type Queryable, type Tx, withTransaction } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { type AuthContext, authorize, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { finalizeAttempt } from '../attempts.js';
import { liveStatus, PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR } from '../allocation.js';
import { COUNTED_EVENT_TYPES } from '../rules.js';
import { idParams, parse } from '../validation.js';

/** A candidate counts as online while the app has checked in within this many seconds. */
export const ONLINE_WINDOW_SECONDS = 45;
/** The most extra time an invigilator can give one attempt, in total. */
export const MAX_EXTENSION_MINUTES = 120;

const messageBody = z.object({ kind: z.enum(['message', 'warning']).default('message'), body: z.string().trim().min(1).max(1000) });
const extendBody = z.object({ minutes: z.number().int().min(1).max(MAX_EXTENSION_MINUTES), reason: z.string().trim().min(1).max(500) });
const endBody = z.object({ reason: z.string().trim().min(1).max(500) });
const noteBody = z.object({ note: z.string().trim().min(1).max(2000) });

type OrgAuth = AuthContext & { organisationId: string };

interface Viewer {
  /** Set for an invigilator: they only ever see candidates assigned to them. */
  invigilatorId: string | null;
  scope: 'invigilator' | 'supervisor';
  status: 'active' | 'paused' | 'suspended' | null;
  maxActive: number;
}

/**
 * Who is looking. An invigilator sees only their assigned candidates (spec
 * section 8). Staff who manage sessions and are not invigilators supervise
 * the whole session.
 */
async function viewer(q: Queryable, auth: OrgAuth): Promise<Viewer> {
  const { rows } = await q.query<{ id: string; status: 'active' | 'paused' | 'suspended'; max_active: number }>(
    'SELECT id, status, max_active FROM invigilators WHERE organisation_id = $1 AND user_id = $2',
    [auth.organisationId, auth.userId],
  );
  const inv = rows[0];
  if (inv) {
    if (inv.status === 'suspended') throw forbidden('Invigilator access is suspended');
    return { invigilatorId: inv.id, scope: 'invigilator', status: inv.status, maxActive: inv.max_active };
  }
  if (auth.permissions.has('session:manage')) return { invigilatorId: null, scope: 'supervisor', status: null, maxActive: 0 };
  throw forbidden('Only invigilators and session managers can open the live console');
}

interface AttemptScope {
  attemptId: string;
  sessionId: string;
  candidateId: string;
  status: string;
}

/** Finds an attempt the caller may act on, and locks it when inside a transaction. Out of scope reads as not found. */
async function scopedAttempt(q: Queryable, auth: OrgAuth, v: Viewer, attemptId: string, lock = false): Promise<AttemptScope> {
  const { rows } = await q.query<AttemptScope>(
    `SELECT at.id AS "attemptId", a.session_id AS "sessionId", a.candidate_id AS "candidateId", at.status
       FROM attempts at JOIN exam_assignments a ON a.id = at.assignment_id
      WHERE at.id = $1 AND at.organisation_id = $2
        AND ($3::uuid IS NULL OR EXISTS (
              SELECT 1 FROM invigilation_assignments ia
               WHERE ia.session_id = a.session_id AND ia.candidate_id = a.candidate_id
                 AND ia.invigilator_id = $3 AND ia.active))
      ${lock ? 'FOR UPDATE OF at' : ''}`,
    [attemptId, auth.organisationId, v.invigilatorId],
  );
  if (!rows[0]) throw notFound('Attempt');
  return rows[0];
}

async function recordStaffEvent(tx: Tx, auth: OrgAuth, v: Viewer, attemptId: string, type: string, severity: string, data: object) {
  await tx.query(
    `INSERT INTO events (organisation_id, attempt_id, invigilator_id, type, severity, occurred_at, data)
     VALUES ($1, $2, $3, $4, $5, date_trunc('milliseconds', now()), $6)`,
    [auth.organisationId, attemptId, v.invigilatorId, type, severity, { ...data, byUserId: auth.userId }],
  );
}

export async function liveRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;

  // Sessions the caller can watch: an invigilator's rostered sessions, or every current session for a supervisor.
  app.get('/live/sessions', { preHandler: authorize('live:view') }, async (req) => {
    const auth = requireOrg(req);
    const v = await viewer(db, auth);
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.status, s.starts_at AS "startsAt", s.ends_at AS "endsAt", v.manifest->>'name' AS "examName",
              (SELECT count(*)::int FROM exam_assignments a WHERE a.session_id = s.id AND a.status <> 'revoked') AS candidates,
              (SELECT count(*)::int FROM invigilation_assignments ia
                WHERE ia.session_id = s.id AND ia.active AND ($2::uuid IS NULL OR ia.invigilator_id = $2)) AS assigned
         FROM sessions s JOIN exam_versions v ON v.id = s.exam_version_id
        WHERE s.organisation_id = $1 AND s.status IN ('scheduled', 'open')
          AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM session_invigilators si WHERE si.session_id = s.id AND si.invigilator_id = $2))
        ORDER BY s.starts_at, s.id LIMIT 100`,
      [auth.organisationId, v.invigilatorId],
    );
    return { scope: v.scope, items: rows };
  });

  // The live console for one session.
  app.get('/live/sessions/:id', { preHandler: authorize('live:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const v = await viewer(db, auth);
    const { rows: session } = await db.query(
      `SELECT s.id, s.name, s.status, s.starts_at AS "startsAt", s.ends_at AS "endsAt", v.manifest->>'name' AS "examName"
         FROM sessions s JOIN exam_versions v ON v.id = s.exam_version_id WHERE s.id = $1 AND s.organisation_id = $2`,
      [id, auth.organisationId],
    );
    if (!session[0]) throw notFound('Session');

    const { rows: candidates } = await db.query(
      `SELECT ia.id AS "assignmentId", c.id AS "candidateId", c.full_name AS "fullName", c.student_id AS "studentId",
              a.status AS "entitlementStatus", ia.assigned_at AS "assignedAt", iu.display_name AS "invigilatorName",
              at.id AS "attemptId", at.status AS "attemptStatus", at.started_at AS "startedAt", at.deadline_at AS "deadlineAt",
              at.submitted_at AS "submittedAt", at.submitted_by AS "submittedBy", at.last_seen_at AS "lastSeenAt",
              coalesce(at.last_seen_at > now() - make_interval(secs => $4), false) AS online,
              (SELECT count(*)::int FROM events e WHERE e.attempt_id = at.id AND e.type = ANY($5::text[])) AS violations,
              (SELECT json_build_object('type', e.type, 'severity', e.severity, 'occurredAt', e.occurred_at)
                 FROM events e WHERE e.attempt_id = at.id ORDER BY e.occurred_at DESC, e.seq DESC LIMIT 1) AS "lastEvent",
              (SELECT r.report->'os'->>'platform' FROM readiness_checks r WHERE r.id = a.last_check_id) AS platform
         FROM exam_assignments a
         JOIN candidates c ON c.id = a.candidate_id
         LEFT JOIN invigilation_assignments ia ON ia.session_id = a.session_id AND ia.candidate_id = a.candidate_id AND ia.active
         LEFT JOIN invigilators i ON i.id = ia.invigilator_id
         LEFT JOIN users iu ON iu.id = i.user_id
         LEFT JOIN attempts at ON at.assignment_id = a.id
        WHERE a.session_id = $1 AND a.organisation_id = $2 AND a.status <> 'revoked'
          AND ($3::uuid IS NULL OR ia.invigilator_id = $3)
        ORDER BY c.full_name, c.id`,
      [id, auth.organisationId, v.invigilatorId, ONLINE_WINDOW_SECONDS, COUNTED_EVENT_TYPES],
    );

    let load: { active: number; capacity: number } | null = null;
    let status: string | null = null;
    if (v.invigilatorId) {
      const { rows } = await db.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM invigilation_assignments WHERE invigilator_id = $1 AND active',
        [v.invigilatorId],
      );
      const capacity = Math.min(v.maxActive, PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR);
      load = { active: rows[0]!.total, capacity };
      status = liveStatus(v.status!, load.active, capacity);
    }
    return {
      sessionId: id,
      session: session[0],
      scope: v.scope,
      invigilatorId: v.invigilatorId,
      status,
      load,
      serverTime: new Date().toISOString(),
      candidates,
    };
  });

  // One candidate's attempt in detail: the timeline and the messages sent.
  app.get('/live/attempts/:id', { preHandler: authorize('live:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const v = await viewer(db, auth);
    await scopedAttempt(db, auth, v, id);
    const { rows } = await db.query(
      `SELECT at.id, at.status, at.started_at AS "startedAt", at.deadline_at AS "deadlineAt", at.submitted_at AS "submittedAt",
              at.submitted_by AS "submittedBy", at.last_seen_at AS "lastSeenAt",
              coalesce(at.last_seen_at > now() - make_interval(secs => $2), false) AS online,
              c.id AS "candidateId", c.full_name AS "fullName", c.student_id AS "studentId", c.email,
              s.id AS "sessionId", s.name AS "sessionName", v.manifest->>'name' AS "examName",
              (SELECT count(*)::int FROM answers an WHERE an.attempt_id = at.id) AS answered,
              jsonb_array_length(v.manifest->'questions') AS total
         FROM attempts at
         JOIN exam_assignments a ON a.id = at.assignment_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN sessions s ON s.id = a.session_id
         JOIN exam_versions v ON v.id = at.exam_version_id
        WHERE at.id = $1`,
      [id, ONLINE_WINDOW_SECONDS],
    );
    const { rows: timeline } = await db.query(
      `SELECT type, severity, occurred_at AS "occurredAt", data FROM events WHERE attempt_id = $1 ORDER BY occurred_at, seq`,
      [id],
    );
    const { rows: messages } = await db.query(
      `SELECT m.id, m.kind, m.body, m.created_at AS "createdAt", m.read_at AS "deliveredAt", u.display_name AS "sender"
         FROM attempt_messages m LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.attempt_id = $1 ORDER BY m.seq`,
      [id],
    );
    return { ...rows[0], scope: v.scope, timeline, messages };
  });

  app.post('/live/attempts/:id/messages', { preHandler: authorize('live:view') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const body = parse(messageBody, req.body);
    const created = await withTransaction(db, async (tx) => {
      const v = await viewer(tx, auth);
      const a = await scopedAttempt(tx, auth, v, id, true);
      if (a.status !== 'active') throw conflict('This attempt has ended');
      const { rows } = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO attempt_messages (organisation_id, attempt_id, sender_user_id, kind, body)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
        [auth.organisationId, id, auth.userId, body.kind, body.body],
      );
      await recordStaffEvent(tx, auth, v, id, body.kind === 'warning' ? 'invigilator_warning' : 'invigilator_message', body.kind === 'warning' ? 'warning' : 'info', {
        messageId: rows[0]!.id,
      });
      await audit(tx, { ...auditFrom(req), action: `live.${body.kind}`, targetType: 'attempt', targetId: id });
      return { id: rows[0]!.id, kind: body.kind, body: body.body, createdAt: rows[0]!.created_at };
    });
    return reply.code(201).send(created);
  });

  // Extra time, for example after a technical problem the candidate did not cause.
  app.post('/live/attempts/:id/extend', { preHandler: authorize('live:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const body = parse(extendBody, req.body);
    return withTransaction(db, async (tx) => {
      const v = await viewer(tx, auth);
      const a = await scopedAttempt(tx, auth, v, id, true);
      if (a.status !== 'active') throw conflict('This attempt has ended');
      const { rows: over } = await tx.query<{ expired: boolean }>(
        'SELECT now() > deadline_at + make_interval(secs => $2) AS expired FROM attempts WHERE id = $1',
        [id, config.attemptGraceSeconds],
      );
      if (over[0]!.expired) throw conflict('The time for this attempt has already run out');
      const { rows: given } = await tx.query<{ minutes: number }>(
        `SELECT coalesce(sum((data->>'minutes')::int), 0)::int AS minutes FROM events WHERE attempt_id = $1 AND type = 'time_extended'`,
        [id],
      );
      if (given[0]!.minutes + body.minutes > MAX_EXTENSION_MINUTES) {
        throw conflict(`At most ${MAX_EXTENSION_MINUTES} extra minutes can be given; ${given[0]!.minutes} already given`);
      }
      const { rows } = await tx.query<{ deadline_at: Date }>(
        `UPDATE attempts SET deadline_at = deadline_at + make_interval(mins => $2) WHERE id = $1 RETURNING deadline_at`,
        [id, body.minutes],
      );
      await recordStaffEvent(tx, auth, v, id, 'time_extended', 'info', { minutes: body.minutes, reason: body.reason });
      await tx.query(
        `INSERT INTO attempt_messages (organisation_id, attempt_id, sender_user_id, kind, body) VALUES ($1, $2, $3, 'message', $4)`,
        [auth.organisationId, id, auth.userId, `You have been given ${body.minutes} extra minute${body.minutes === 1 ? '' : 's'}.`],
      );
      await audit(tx, { ...auditFrom(req), action: 'live.extend', targetType: 'attempt', targetId: id, data: body });
      return { deadlineAt: rows[0]!.deadline_at.toISOString(), extraMinutes: given[0]!.minutes + body.minutes };
    });
  });

  // Ends an attempt now, keeping every answer saved so far. Recorded with the reason.
  app.post('/live/attempts/:id/end', { preHandler: authorize('live:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const body = parse(endBody, req.body);
    return withTransaction(db, async (tx) => {
      const v = await viewer(tx, auth);
      const a = await scopedAttempt(tx, auth, v, id, true);
      if (a.status !== 'active') throw conflict('This attempt has already ended');
      await recordStaffEvent(tx, auth, v, id, 'attempt_ended_by_invigilator', 'high', { reason: body.reason });
      const receipt = await finalizeAttempt(tx, config, id, 'system', { userId: auth.userId, ip: req.ip });
      await audit(tx, { ...auditFrom(req), action: 'live.end_attempt', targetType: 'attempt', targetId: id, data: body });
      return { receipt };
    });
  });

  // A note on the timeline, for example "candidate looked away repeatedly".
  app.post('/live/attempts/:id/notes', { preHandler: authorize('live:view') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const body = parse(noteBody, req.body);
    await withTransaction(db, async (tx) => {
      const v = await viewer(tx, auth);
      await scopedAttempt(tx, auth, v, id);
      await recordStaffEvent(tx, auth, v, id, 'invigilator_note', 'warning', { note: body.note });
      await audit(tx, { ...auditFrom(req), action: 'live.note', targetType: 'attempt', targetId: id });
    });
    return reply.code(201).send({ ok: true });
  });
}
