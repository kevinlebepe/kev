import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { noticeHash } from '../notice.js';
import type { AppDeps } from '../context.js';
import { isUniqueViolation, withTransaction } from '../db.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { authorize, requireOrg, requireSuperAdmin } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { findOrCreateUser, roleIdByKey } from '../users.js';
import { inviteStaff } from '../userTokens.js';
import { idParams, page, pagination, parse, password } from '../validation.js';

const domain = z
  .string()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Invalid domain');

const createOrganisationBody = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(200),
  mode: z.enum(['university', 'school', 'employer', 'recruitment_agency', 'certification', 'other']),
  approvedEmailDomains: z.array(domain).max(50).default([]),
  owner: z.object({ email: z.email(), displayName: z.string().min(1).max(200), password: password.optional() }),
});

const updateOrganisationBody = z.object({
  name: z.string().min(1).max(200).optional(),
  approvedEmailDomains: z.array(domain).max(50).optional(),
  /** Staff must use two factor sign in; until they turn it on they have no staff access. */
  requireStaffMfa: z.boolean().optional(),
  /** Days to keep recordings after submission; null keeps them until deleted by hand. */
  recordingRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  /** Shown to candidates before each exam; they must agree before starting. Null removes it. */
  candidateNotice: z.string().trim().max(5000).nullable().optional(),
  /** Staff may issue exam access codes as a fallback for signing in. */
  allowAccessCodes: z.boolean().optional(),
  /** The colour candidates see, as #rrggbb; null for the default. */
  brandColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});

const staffRole = z.enum(['owner', 'admin', 'exam_manager', 'invigilator', 'reviewer', 'support']);

const addUserBody = z.object({
  email: z.email(),
  displayName: z.string().min(1).max(200),
  password: password.optional(),
  role: staffRole,
});

/** Callers may only address their own organisation; anything else looks like a missing resource. */
function ownOrganisation(orgId: string, requested: string) {
  if (orgId !== requested) throw notFound('Organisation');
}

export async function organisationRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  app.post('/platform/organisations', { preHandler: requireSuperAdmin }, async (req, reply) => {
    const body = parse(createOrganisationBody, req.body);
    const result = await withTransaction(db, async (tx) => {
      const { rows } = await tx
        .query<{ id: string }>(
          `INSERT INTO organisations (slug, name, mode, approved_email_domains)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [body.slug, body.name, body.mode, body.approvedEmailDomains],
        )
        .catch((err) => {
          if (isUniqueViolation(err)) throw conflict('Organisation slug already in use');
          throw err;
        });
      const organisationId = rows[0]!.id;
      const owner = await findOrCreateUser(tx, body.owner);
      await tx.query('INSERT INTO organisation_users (organisation_id, user_id, role_id) VALUES ($1, $2, $3)', [
        organisationId,
        owner.id,
        await roleIdByKey(tx, organisationId, 'owner'),
      ]);
      if (owner.needsInvitation) await inviteStaff(tx, deps.config, { userId: owner.id, email: body.owner.email, organisationId, role: 'owner' });
      await audit(tx, {
        ...auditFrom(req),
        organisationId,
        action: 'organisation.create',
        targetType: 'organisation',
        targetId: organisationId,
        data: { slug: body.slug, ownerUserId: owner.id },
      });
      return { id: organisationId, ownerUserId: owner.id };
    });
    return reply.code(201).send(result);
  });

  app.get('/organisations/:id', async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    ownOrganisation(auth.organisationId, id);
    if (auth.permissions.size === 0) throw forbidden();
    const { rows } = await db.query(
      `SELECT id, slug, name, mode, approved_email_domains AS "approvedEmailDomains", require_staff_mfa AS "requireStaffMfa",
              recording_retention_days AS "recordingRetentionDays", candidate_notice AS "candidateNotice",
              allow_access_codes AS "allowAccessCodes", brand_colour AS "brandColour", logo_key IS NOT NULL AS "hasLogo", created_at AS "createdAt"
         FROM organisations WHERE id = $1`,
      [id],
    );
    return rows[0];
  });

  app.patch('/organisations/:id', { preHandler: authorize('organisation:manage_security') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    ownOrganisation(auth.organisationId, id);
    const body = parse(updateOrganisationBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE organisations
            SET name = coalesce($2, name),
                approved_email_domains = coalesce($3, approved_email_domains),
                require_staff_mfa = coalesce($4, require_staff_mfa),
                recording_retention_days = CASE WHEN $5::boolean THEN $6::int ELSE recording_retention_days END,
                candidate_notice = CASE WHEN $7::boolean THEN nullif($8::text, '') ELSE candidate_notice END,
                allow_access_codes = coalesce($9, allow_access_codes),
                brand_colour = CASE WHEN $10::boolean THEN $11::text ELSE brand_colour END
          WHERE id = $1
          RETURNING id, slug, name, mode, approved_email_domains AS "approvedEmailDomains", require_staff_mfa AS "requireStaffMfa",
                    recording_retention_days AS "recordingRetentionDays", candidate_notice AS "candidateNotice",
                    allow_access_codes AS "allowAccessCodes", brand_colour AS "brandColour", logo_key IS NOT NULL AS "hasLogo"`,
        [
          id,
          body.name ?? null,
          body.approvedEmailDomains ?? null,
          body.requireStaffMfa ?? null,
          body.recordingRetentionDays !== undefined,
          body.recordingRetentionDays ?? null,
          body.candidateNotice !== undefined,
          body.candidateNotice ?? null,
          body.allowAccessCodes ?? null,
          body.brandColour !== undefined,
          body.brandColour ?? null,
        ],
      );
      // The notice itself can be long; the audit keeps its fingerprint.
      const { candidateNotice, ...rest } = body;
      await audit(tx, {
        ...auditFrom(req),
        action: 'organisation.update',
        targetType: 'organisation',
        targetId: id,
        data: { ...rest, ...(candidateNotice !== undefined ? { candidateNoticeSha256: candidateNotice ? noticeHash(candidateNotice) : null } : {}) },
      });
      return rows[0];
    });
  });

  app.get('/organisations/:id/users', { preHandler: authorize('organisation:manage_users') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    ownOrganisation(auth.organisationId, id);
    const { limit, offset } = parse(pagination, req.query);
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", r.key AS role, ou.status
         FROM organisation_users ou
         JOIN users u ON u.id = ou.user_id
         JOIN roles r ON r.id = ou.role_id
        WHERE ou.organisation_id = $1
        ORDER BY u.email LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );
    return page(rows, limit, offset);
  });

  app.post('/organisations/:id/users', { preHandler: authorize('organisation:manage_users') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    ownOrganisation(auth.organisationId, id);
    const body = parse(addUserBody, req.body);
    // Only owners can create other owners.
    if (body.role === 'owner' && !auth.permissions.has('organisation:manage_security')) throw forbidden();

    const result = await withTransaction(db, async (tx) => {
      const user = await findOrCreateUser(tx, body);
      if (user.needsInvitation) await inviteStaff(tx, deps.config, { userId: user.id, email: body.email, organisationId: id, role: body.role });
      await tx
        .query('INSERT INTO organisation_users (organisation_id, user_id, role_id) VALUES ($1, $2, $3)', [
          id,
          user.id,
          await roleIdByKey(tx, id, body.role),
        ])
        .catch((err) => {
          if (isUniqueViolation(err)) throw conflict('User is already a member of this organisation');
          throw err;
        });
      await audit(tx, {
        ...auditFrom(req),
        action: 'organisation.user_add',
        targetType: 'user',
        targetId: user.id,
        data: { role: body.role },
      });
      return { userId: user.id, role: body.role, invited: user.needsInvitation };
    });
    return reply.code(201).send(result);
  });

  app.get('/audit', { preHandler: authorize('audit:view') }, async (req) => {
    const auth = requireOrg(req);
    const { limit, offset } = parse(pagination, req.query);
    const { rows } = await db.query(
      `SELECT l.id, l.actor_user_id AS "actorUserId", u.email AS "actorEmail", l.action, l.target_type AS "targetType",
              l.target_id AS "targetId", l.data, l.ip, l.created_at AS "createdAt"
         FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_user_id
        WHERE l.organisation_id = $1
        ORDER BY l.id DESC LIMIT $2 OFFSET $3`,
      [auth.organisationId, limit, offset],
    );
    return page(rows, limit, offset);
  });
}
