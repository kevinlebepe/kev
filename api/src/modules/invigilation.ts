import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { isConstraint, isUniqueViolation, type Tx, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { authorize, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { notify } from '../notifications.js';
import { findOrCreateUser, roleIdByKey } from '../users.js';
import { allocate, liveStatus, PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR } from '../allocation.js';
import { idParams, page, pagination, parse, password } from '../validation.js';

const createInvigilatorBody = z.object({
  email: z.email(),
  displayName: z.string().min(1).max(200),
  password: password.optional(),
  staffId: z.string().max(100).optional(),
  maxActive: z.number().int().min(1).max(PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR).default(PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR),
});

const updateInvigilatorBody = z.object({
  status: z.enum(['active', 'paused', 'suspended']).optional(),
  maxActive: z.number().int().min(1).max(PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR).optional(),
});

const allocateBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto'), sessionId: z.uuid(), randomise: z.boolean().default(false) }),
  z.object({ mode: z.literal('manual'), sessionId: z.uuid(), candidateId: z.uuid(), invigilatorId: z.uuid() }),
]);

const capacityError = () => conflict(`Invigilator is at capacity (maximum ${PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR} active candidates)`);

/** Map the database capacity trigger onto the API's 409 so the backstop surfaces cleanly. */
function rethrowCapacity(err: unknown): never {
  if (isConstraint(err, 'invigilator_capacity')) throw capacityError();
  if (isUniqueViolation(err)) throw conflict('Candidate already has an active invigilator in this session');
  throw err;
}

async function sessionCap(tx: Tx, sessionId: string, organisationId: string): Promise<number> {
  const { rows } = await tx.query<{ cap: number | null }>(
    `SELECT (v.manifest #>> '{config,invigilation,maxCandidatesPerInvigilator}')::int AS cap
       FROM sessions s JOIN exam_versions v ON v.id = s.exam_version_id
      WHERE s.id = $1 AND s.organisation_id = $2
      FOR UPDATE OF s`,
    [sessionId, organisationId],
  );
  if (!rows[0]) throw notFound('Session');
  return rows[0].cap ?? PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR;
}

export async function invigilationRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  app.post('/invigilators', { preHandler: authorize('invigilator:create') }, async (req, reply) => {
    const auth = requireOrg(req);
    const body = parse(createInvigilatorBody, req.body);
    const result = await withTransaction(db, async (tx) => {
      const user = await findOrCreateUser(tx, body);
      await tx.query(
        `INSERT INTO organisation_users (organisation_id, user_id, role_id) VALUES ($1, $2, $3)
         ON CONFLICT (organisation_id, user_id) DO NOTHING`,
        [auth.organisationId, user.id, await roleIdByKey(tx, auth.organisationId, 'invigilator')],
      );
      // An existing member keeps their role, so it must already allow the live
      // console. Changing it here could silently demote an owner or admin.
      const { rows: access } = await tx.query<{ role: string; live: boolean }>(
        `SELECT r.key AS role,
                EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = ou.role_id AND rp.permission_key = 'live:view') AS live
           FROM organisation_users ou JOIN roles r ON r.id = ou.role_id
          WHERE ou.organisation_id = $1 AND ou.user_id = $2`,
        [auth.organisationId, user.id],
      );
      if (!access[0]?.live) {
        throw conflict(
          `This user already has the ${access[0]?.role ?? 'unknown'} role, which cannot open the live console; change their role first`,
        );
      }
      const { rows } = await tx
        .query<{ id: string }>(
          `INSERT INTO invigilators (organisation_id, user_id, staff_id, max_active) VALUES ($1, $2, $3, $4) RETURNING id`,
          [auth.organisationId, user.id, body.staffId ?? null, body.maxActive],
        )
        .catch((err) => {
          if (isUniqueViolation(err)) throw conflict('This user is already an invigilator');
          throw err;
        });
      const id = rows[0]!.id;
      await audit(tx, { ...auditFrom(req), action: 'invigilator.create', targetType: 'invigilator', targetId: id });
      return { id, userId: user.id };
    });
    return reply.code(201).send(result);
  });

  app.get('/invigilators', { preHandler: authorize('invigilator:create') }, async (req) => {
    const auth = requireOrg(req);
    const { limit, offset } = parse(pagination, req.query);
    const { rows } = await db.query<{
      id: string;
      displayName: string;
      email: string;
      status: 'active' | 'paused' | 'suspended';
      maxActive: number;
      load: number;
    }>(
      `SELECT i.id, u.display_name AS "displayName", u.email, i.status, i.max_active AS "maxActive",
              (SELECT count(*)::int FROM invigilation_assignments ia WHERE ia.invigilator_id = i.id AND ia.active) AS load
         FROM invigilators i JOIN users u ON u.id = i.user_id
        WHERE i.organisation_id = $1
        ORDER BY u.display_name, i.id LIMIT $2 OFFSET $3`,
      [auth.organisationId, limit, offset],
    );
    return page(
      rows.map((r) => ({ ...r, liveStatus: liveStatus(r.status, r.load, r.maxActive) })),
      limit,
      offset,
    );
  });

  app.patch('/invigilators/:id', { preHandler: authorize('invigilator:create') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const body = parse(updateInvigilatorBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE invigilators SET status = coalesce($3, status), max_active = coalesce($4, max_active)
          WHERE id = $1 AND organisation_id = $2
          RETURNING id, status, max_active AS "maxActive"`,
        [id, auth.organisationId, body.status ?? null, body.maxActive ?? null],
      );
      if (!rows[0]) throw notFound('Invigilator');
      // Existing assignments are preserved when paused/suspended or when the
      // cap is lowered; reassignment follows the session's failover policy.
      await audit(tx, { ...auditFrom(req), action: 'invigilator.update', targetType: 'invigilator', targetId: id, data: body });
      return rows[0];
    });
  });

  app.post('/live/assignments', { preHandler: authorize('invigilation:allocate') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(allocateBody, req.body);

    return withTransaction(db, async (tx) => {
      // Locking the session serialises allocation runs for it.
      const cap = await sessionCap(tx, body.sessionId, auth.organisationId);

      // Rostered, active invigilators with their current load, locked in id
      // order so concurrent allocations cannot deadlock or double-count.
      const { rows: invigilators } = await tx.query<{ id: string; capacity: number; load: number }>(
        `SELECT i.id, i.max_active AS capacity,
                (SELECT count(*)::int FROM invigilation_assignments ia WHERE ia.invigilator_id = i.id AND ia.active) AS load
           FROM invigilators i
           JOIN session_invigilators si ON si.invigilator_id = i.id AND si.session_id = $1
          WHERE i.organisation_id = $2 AND i.status = 'active'
          ORDER BY i.id
          FOR UPDATE OF i`,
        [body.sessionId, auth.organisationId],
      );

      if (body.mode === 'manual') {
        const inv = invigilators.find((i) => i.id === body.invigilatorId);
        if (!inv) throw badRequest('Invigilator is not active on this session roster');
        const { rowCount } = await tx.query(
          `SELECT 1 FROM exam_assignments a JOIN candidates c ON c.id = a.candidate_id
            WHERE a.session_id = $1 AND a.candidate_id = $2 AND a.status NOT IN ('revoked', 'completed')
              AND c.status = 'approved'`,
          [body.sessionId, body.candidateId],
        );
        if (!rowCount) throw badRequest('Candidate is not assigned to this session');
        if (inv.load >= Math.min(inv.capacity, cap)) throw capacityError();

        const { rows } = await tx
          .query<{ id: string }>(
            `INSERT INTO invigilation_assignments (organisation_id, session_id, invigilator_id, candidate_id)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [auth.organisationId, body.sessionId, body.invigilatorId, body.candidateId],
          )
          .catch(rethrowCapacity);
        await audit(tx, {
          ...auditFrom(req),
          action: 'invigilation.assign',
          targetType: 'invigilation_assignment',
          targetId: rows[0]!.id,
          data: { mode: 'manual', invigilatorId: body.invigilatorId, candidateId: body.candidateId },
        });
        return { assignments: [{ id: rows[0]!.id, candidateId: body.candidateId, invigilatorId: body.invigilatorId }], unassigned: [] };
      }

      // Auto: every eligible candidate in the session without a live invigilator.
      const { rows: pending } = await tx.query<{ candidate_id: string }>(
        `SELECT a.candidate_id FROM exam_assignments a
           JOIN candidates c ON c.id = a.candidate_id
          WHERE a.session_id = $1 AND a.status NOT IN ('revoked', 'completed') AND c.status = 'approved'
            AND NOT EXISTS (SELECT 1 FROM invigilation_assignments ia
                             WHERE ia.session_id = a.session_id AND ia.candidate_id = a.candidate_id AND ia.active)
          ORDER BY a.created_at, a.candidate_id`,
        [body.sessionId],
      );
      const plan = allocate(
        pending.map((p) => p.candidate_id),
        invigilators,
        { sessionCap: cap, random: body.randomise ? Math.random : undefined },
      );

      const assignments: { id: string; candidateId: string; invigilatorId: string }[] = [];
      for (const a of plan.assignments) {
        const { rows } = await tx
          .query<{ id: string }>(
            `INSERT INTO invigilation_assignments (organisation_id, session_id, invigilator_id, candidate_id)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [auth.organisationId, body.sessionId, a.invigilatorId, a.candidateId],
          )
          .catch(rethrowCapacity);
        assignments.push({ id: rows[0]!.id, ...a });
      }

      await audit(tx, {
        ...auditFrom(req),
        action: 'invigilation.auto_allocate',
        targetType: 'session',
        targetId: body.sessionId,
        data: { assigned: assignments.length, unassigned: plan.unassigned.length, randomise: body.randomise },
      });
      if (plan.unassigned.length) {
        // All invigilators are full: candidates wait in the unassigned queue and the administrator is alerted.
        await notify(tx, {
          organisationId: auth.organisationId,
          kind: 'invigilator_capacity_alert',
          recipientUserId: auth.userId,
          payload: { sessionId: body.sessionId, unassigned: plan.unassigned.length },
        });
        await audit(tx, {
          ...auditFrom(req),
          action: 'invigilation.capacity_alert',
          targetType: 'session',
          targetId: body.sessionId,
          data: { unassigned: plan.unassigned },
        });
      }
      return { assignments, unassigned: plan.unassigned };
    });
  });

  app.post('/live/assignments/:id/release', { preHandler: authorize('invigilation:allocate') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE invigilation_assignments SET active = false, released_at = now()
          WHERE id = $1 AND organisation_id = $2 AND active
          RETURNING id, invigilator_id AS "invigilatorId", candidate_id AS "candidateId"`,
        [id, auth.organisationId],
      );
      if (!rows[0]) throw notFound('Active invigilation assignment');
      await audit(tx, { ...auditFrom(req), action: 'invigilation.release', targetType: 'invigilation_assignment', targetId: id });
      return rows[0];
    });
  });

  // Live console: an invigilator only ever sees candidates currently assigned
  // to them (spec section 8, "never expose candidates outside scope").
  app.get('/live/sessions/:id', { preHandler: authorize('live:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rows: me } = await db.query<{ id: string; status: 'active' | 'paused' | 'suspended'; max_active: number }>(
      'SELECT id, status, max_active FROM invigilators WHERE organisation_id = $1 AND user_id = $2',
      [auth.organisationId, auth.userId],
    );
    const invigilator = me[0];
    if (!invigilator) throw forbidden('Only invigilators can open the live console');
    if (invigilator.status === 'suspended') throw forbidden('Invigilator access is suspended');

    const { rowCount } = await db.query('SELECT 1 FROM sessions WHERE id = $1 AND organisation_id = $2', [id, auth.organisationId]);
    if (!rowCount) throw notFound('Session');

    const { rows: candidates } = await db.query(
      `SELECT ia.id AS "assignmentId", c.id AS "candidateId", c.full_name AS "fullName", c.student_id AS "studentId",
              a.status AS "entitlementStatus", ia.assigned_at AS "assignedAt"
         FROM invigilation_assignments ia
         JOIN candidates c ON c.id = ia.candidate_id
         JOIN exam_assignments a ON a.session_id = ia.session_id AND a.candidate_id = ia.candidate_id
        WHERE ia.session_id = $1 AND ia.invigilator_id = $2 AND ia.active
        ORDER BY c.full_name`,
      [id, invigilator.id],
    );
    const { rows: load } = await db.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM invigilation_assignments WHERE invigilator_id = $1 AND active',
      [invigilator.id],
    );
    const total = load[0]!.total;
    const capacity = Math.min(invigilator.max_active, PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR);
    return {
      sessionId: id,
      invigilatorId: invigilator.id,
      status: liveStatus(invigilator.status, total, capacity),
      load: { active: total, capacity },
      candidates,
    };
  });
}
