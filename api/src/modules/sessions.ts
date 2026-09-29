import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { authorize, authorizeAny, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { notify } from '../notifications.js';
import { idParams, page, pagination, parse } from '../validation.js';

const createSessionBody = z
  .object({
    examVersionId: z.uuid(),
    name: z.string().min(1).max(200),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
  })
  .refine((s) => new Date(s.endsAt) > new Date(s.startsAt), 'endsAt must be after startsAt');

const updateSessionBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    status: z.enum(['scheduled', 'open', 'closed', 'cancelled']).optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const assignmentUpdateBody = z.object({
  /** Standing extra time for this candidate, for example an accommodation. */
  extraMinutes: z.number().int().min(0).max(600),
  reason: z.string().trim().min(1).max(500),
});

const listQuery = pagination.extend({ status: z.enum(['scheduled', 'open', 'closed', 'cancelled']).optional() });

/** Status changes a session may make. Closed and cancelled sessions are final. */
const TRANSITIONS: Record<string, string[]> = {
  scheduled: ['open', 'cancelled'],
  open: ['closed', 'cancelled'],
  closed: [],
  cancelled: [],
};

const rosterBody = z.object({ invigilatorIds: z.array(z.uuid()).min(1).max(500) });

const assignBody = z.object({ sessionId: z.uuid(), candidateIds: z.array(z.uuid()).min(1).max(5000) });

export async function sessionRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  app.post('/sessions', { preHandler: authorize('session:manage') }, async (req, reply) => {
    const auth = requireOrg(req);
    const body = parse(createSessionBody, req.body);
    const session = await withTransaction(db, async (tx) => {
      // Sessions always pin an immutable exam version, never the editable draft.
      const { rowCount } = await tx.query('SELECT 1 FROM exam_versions WHERE id = $1 AND organisation_id = $2', [
        body.examVersionId,
        auth.organisationId,
      ]);
      if (!rowCount) throw notFound('Exam version');
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO sessions (organisation_id, exam_version_id, name, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [auth.organisationId, body.examVersionId, body.name, body.startsAt, body.endsAt],
      );
      const id = rows[0]!.id;
      await audit(tx, { ...auditFrom(req), action: 'session.create', targetType: 'session', targetId: id, data: body });
      return { id, status: 'scheduled' };
    });
    return reply.code(201).send(session);
  });

  // Session managers, and markers and reviewers looking for work to mark.
  app.get('/sessions', { preHandler: authorizeAny('session:manage', 'report:view') }, async (req) => {
    const auth = requireOrg(req);
    const { limit, offset, status } = parse(listQuery, req.query);
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.status, s.starts_at AS "startsAt", s.ends_at AS "endsAt",
              s.exam_version_id AS "examVersionId", v.exam_id AS "examId", v.version AS "examVersion", v.manifest->>'name' AS "examName",
              (SELECT count(*)::int FROM exam_assignments a WHERE a.session_id = s.id AND a.status <> 'revoked') AS candidates,
              (SELECT count(*)::int FROM exam_assignments a WHERE a.session_id = s.id AND a.status IN ('submitted', 'completed')) AS submitted
         FROM sessions s JOIN exam_versions v ON v.id = s.exam_version_id
        WHERE s.organisation_id = $1 AND ($2::text IS NULL OR s.status = $2)
        ORDER BY s.starts_at DESC, s.id LIMIT $3 OFFSET $4`,
      [auth.organisationId, status ?? null, limit, offset],
    );
    return page(rows, limit, offset);
  });

  app.patch('/sessions/:id', { preHandler: authorize('session:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const body = parse(updateSessionBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ status: string; starts_at: Date; ends_at: Date }>(
        'SELECT status, starts_at, ends_at FROM sessions WHERE id = $1 AND organisation_id = $2 FOR UPDATE',
        [id, auth.organisationId],
      );
      const current = rows[0];
      if (!current) throw notFound('Session');
      if (body.status && body.status !== current.status && !TRANSITIONS[current.status]!.includes(body.status)) {
        throw conflict(`A ${current.status} session cannot become ${body.status}`);
      }
      if ((body.startsAt || body.endsAt) && current.status !== 'scheduled') throw conflict('Times can only change before the session opens');
      const startsAt = body.startsAt ? new Date(body.startsAt) : current.starts_at;
      const endsAt = body.endsAt ? new Date(body.endsAt) : current.ends_at;
      if (endsAt <= startsAt) throw badRequest('endsAt must be after startsAt');

      const { rows: updated } = await tx.query(
        `UPDATE sessions SET name = coalesce($3, name), status = coalesce($4, status), starts_at = $5, ends_at = $6
          WHERE id = $1 AND organisation_id = $2
          RETURNING id, name, status, starts_at AS "startsAt", ends_at AS "endsAt"`,
        [id, auth.organisationId, body.name ?? null, body.status ?? null, startsAt, endsAt],
      );
      await audit(tx, { ...auditFrom(req), action: 'session.update', targetType: 'session', targetId: id, data: body });
      return updated[0];
    });
  });

  // Extra time for one candidate. If their exam is already running, the deadline moves by the difference.
  app.patch('/assignments/:id', { preHandler: authorize('session:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const body = parse(assignmentUpdateBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ extra_minutes: number; status: string }>(
        'SELECT extra_minutes, status FROM exam_assignments WHERE id = $1 AND organisation_id = $2 FOR UPDATE',
        [id, auth.organisationId],
      );
      if (!rows[0]) throw notFound('Assignment');
      if (['submitted', 'completed', 'revoked'].includes(rows[0].status)) throw conflict('This candidate has already finished');
      const delta = body.extraMinutes - rows[0].extra_minutes;
      await tx.query('UPDATE exam_assignments SET extra_minutes = $2 WHERE id = $1', [id, body.extraMinutes]);
      const { rows: running } = await tx.query<{ id: string; deadline_at: Date }>(
        `UPDATE attempts SET deadline_at = deadline_at + make_interval(mins => $2)
          WHERE assignment_id = $1 AND status = 'active' RETURNING id, deadline_at`,
        [id, delta],
      );
      if (running[0] && delta !== 0) {
        await tx.query(
          `INSERT INTO events (organisation_id, attempt_id, type, severity, occurred_at, data)
           VALUES ($1, $2, 'time_extended', 'info', date_trunc('milliseconds', now()), $3)`,
          [auth.organisationId, running[0].id, { minutes: delta, reason: body.reason, accommodation: true, byUserId: auth.userId }],
        );
      }
      await audit(tx, { ...auditFrom(req), action: 'assignment.extra_time', targetType: 'exam_assignment', targetId: id, data: body });
      return { id, extraMinutes: body.extraMinutes, deadlineAt: running[0]?.deadline_at.toISOString() ?? null };
    });
  });

  app.get('/sessions/:id/status', { preHandler: authorize('session:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.status, s.starts_at AS "startsAt", s.ends_at AS "endsAt",
              v.version AS "examVersion", v.exam_id AS "examId"
         FROM sessions s JOIN exam_versions v ON v.id = s.exam_version_id
        WHERE s.id = $1 AND s.organisation_id = $2`,
      [id, auth.organisationId],
    );
    if (!rows[0]) throw notFound('Session');

    const { rows: byStatus } = await db.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM exam_assignments WHERE session_id = $1 GROUP BY status`,
      [id],
    );
    const { rows: coverage } = await db.query<{ covered: number; uncovered: number }>(
      `SELECT count(*) FILTER (WHERE ia.id IS NOT NULL)::int AS covered,
              count(*) FILTER (WHERE ia.id IS NULL)::int AS uncovered
         FROM exam_assignments a
         LEFT JOIN invigilation_assignments ia
           ON ia.session_id = a.session_id AND ia.candidate_id = a.candidate_id AND ia.active
        WHERE a.session_id = $1 AND a.status NOT IN ('revoked', 'completed')`,
      [id],
    );
    const { rows: invigilators } = await db.query(
      `SELECT i.id, u.display_name AS "displayName", i.status, i.last_seen_at AS "lastSeenAt",
              (SELECT count(*)::int FROM invigilation_assignments ia
                WHERE ia.invigilator_id = i.id AND ia.session_id = $1 AND ia.active) AS load
         FROM session_invigilators si
         JOIN invigilators i ON i.id = si.invigilator_id
         JOIN users u ON u.id = i.user_id
        WHERE si.session_id = $1
        ORDER BY u.display_name`,
      [id],
    );
    return {
      ...rows[0],
      assignments: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
      invigilation: { ...coverage[0], invigilators },
    };
  });

  app.post('/sessions/:id/invigilators', { preHandler: authorize('invigilation:allocate') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { invigilatorIds } = parse(rosterBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query('SELECT 1 FROM sessions WHERE id = $1 AND organisation_id = $2', [
        id,
        auth.organisationId,
      ]);
      if (!rowCount) throw notFound('Session');
      const { rows: owned } = await tx.query<{ id: string }>(
        'SELECT id FROM invigilators WHERE organisation_id = $1 AND id = ANY($2::uuid[])',
        [auth.organisationId, invigilatorIds],
      );
      if (owned.length !== new Set(invigilatorIds).size) throw badRequest('One or more invigilators were not found');
      await tx.query(
        `INSERT INTO session_invigilators (session_id, invigilator_id)
         SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
        [id, invigilatorIds],
      );
      await audit(tx, { ...auditFrom(req), action: 'session.roster_add', targetType: 'session', targetId: id, data: { invigilatorIds } });
      return { sessionId: id, added: owned.length };
    });
  });

  // Creates exam entitlements. Only approved candidates can be assigned
  // (account, approval and entitlement are separate; spec section 4).
  app.post('/assignments', { preHandler: authorize('session:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { sessionId, candidateIds } = parse(assignBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query(
        `SELECT 1 FROM sessions WHERE id = $1 AND organisation_id = $2 AND status IN ('scheduled', 'open')`,
        [sessionId, auth.organisationId],
      );
      if (!rowCount) throw notFound('Session');

      const { rows: candidates } = await tx.query<{ id: string; status: string; user_id: string | null; email: string }>(
        'SELECT id, status, user_id, email FROM candidates WHERE organisation_id = $1 AND id = ANY($2::uuid[])',
        [auth.organisationId, candidateIds],
      );
      const found = new Map(candidates.map((c) => [c.id, c]));
      const rejected: { candidateId: string; reason: string }[] = [];
      const assigned: string[] = [];

      for (const candidateId of new Set(candidateIds)) {
        const c = found.get(candidateId);
        if (!c) {
          rejected.push({ candidateId, reason: 'not_found' });
          continue;
        }
        if (c.status !== 'approved') {
          rejected.push({ candidateId, reason: `candidate_${c.status}` });
          continue;
        }
        const { rowCount: inserted } = await tx.query(
          `INSERT INTO exam_assignments (organisation_id, session_id, candidate_id)
           VALUES ($1, $2, $3) ON CONFLICT (session_id, candidate_id) DO NOTHING`,
          [auth.organisationId, sessionId, candidateId],
        );
        if (!inserted) {
          rejected.push({ candidateId, reason: 'already_assigned' });
          continue;
        }
        assigned.push(candidateId);
        await notify(tx, {
          organisationId: auth.organisationId,
          kind: 'exam_assigned',
          channel: 'email',
          recipientUserId: c.user_id,
          recipientEmail: c.email,
          payload: { sessionId },
        });
      }
      await audit(tx, {
        ...auditFrom(req),
        action: 'session.assign_candidates',
        targetType: 'session',
        targetId: sessionId,
        data: { assigned: assigned.length, rejected: rejected.length },
      });
      return { assigned, rejected };
    });
  });
}
