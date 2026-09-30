import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { authorize, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { hashAccessCode, newAccessCode } from '../accessCodes.js';
import { idParams, parse } from '../validation.js';

// Candidate groups (spec section 5), exam access codes (section 3) and the
// organisation's branding shown to candidates (section 5).

const groupBody = z.object({ name: z.string().trim().min(1).max(200) });
const membersBody = z.object({ candidateIds: z.array(z.uuid()).min(1).max(5000) });
const slugParams = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) });

/** A logo is at most this big, and a PNG or JPEG: never SVG, which can carry script. */
export const MAX_LOGO_BYTES = 200 * 1024;

function imageType(body: Buffer): string | null {
  if (body.length > 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (body.length > 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  return null;
}

export async function peopleRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  app.get('/groups', { preHandler: authorize('candidate:view') }, async (req) => {
    const auth = requireOrg(req);
    const { rows } = await db.query(
      `SELECT g.id, g.name, g.created_at AS "createdAt", count(m.candidate_id)::int AS members
         FROM candidate_groups g LEFT JOIN candidate_group_members m ON m.group_id = g.id
        WHERE g.organisation_id = $1 GROUP BY g.id ORDER BY lower(g.name)`,
      [auth.organisationId],
    );
    return { items: rows };
  });

  app.post('/groups', { preHandler: authorize('candidate:invite') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { name } = parse(groupBody, req.body);
    const created = await withTransaction(db, async (tx) => {
      const { rows } = await tx
        .query<{ id: string }>('INSERT INTO candidate_groups (organisation_id, name) VALUES ($1, $2) RETURNING id', [auth.organisationId, name])
        .catch((err) => {
          if ((err as { code?: string }).code === '23505') throw conflict('A group with this name already exists');
          throw err;
        });
      await audit(tx, { ...auditFrom(req), action: 'group.create', targetType: 'group', targetId: rows[0]!.id, data: { name } });
      return { id: rows[0]!.id, name, members: 0 };
    });
    return reply.code(201).send(created);
  });

  app.delete('/groups/:id', { preHandler: authorize('candidate:invite') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query('DELETE FROM candidate_groups WHERE id = $1 AND organisation_id = $2', [id, auth.organisationId]);
      if (!rowCount) throw notFound('Group');
      await audit(tx, { ...auditFrom(req), action: 'group.delete', targetType: 'group', targetId: id });
      return { deleted: true };
    });
  });

  app.get('/groups/:id/members', { preHandler: authorize('candidate:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rowCount } = await db.query('SELECT 1 FROM candidate_groups WHERE id = $1 AND organisation_id = $2', [id, auth.organisationId]);
    if (!rowCount) throw notFound('Group');
    const { rows } = await db.query(
      `SELECT c.id, c.full_name AS "fullName", c.email, c.student_id AS "studentId", c.status
         FROM candidate_group_members m JOIN candidates c ON c.id = m.candidate_id
        WHERE m.group_id = $1 ORDER BY c.full_name, c.id`,
      [id],
    );
    return { items: rows };
  });

  // Adds candidates to a group, or removes them. Only this organisation's candidates can be added.
  for (const action of ['add', 'remove'] as const) {
    app.post(`/groups/:id/members/${action}`, { preHandler: authorize('candidate:invite') }, async (req) => {
      const auth = requireOrg(req);
      const { id } = parse(idParams, req.params);
      const { candidateIds } = parse(membersBody, req.body);
      return withTransaction(db, async (tx) => {
        const { rowCount } = await tx.query('SELECT 1 FROM candidate_groups WHERE id = $1 AND organisation_id = $2 FOR UPDATE', [id, auth.organisationId]);
        if (!rowCount) throw notFound('Group');
        const { rowCount: changed } =
          action === 'add'
            ? await tx.query(
                `INSERT INTO candidate_group_members (group_id, candidate_id)
                 SELECT $1, c.id FROM candidates c WHERE c.organisation_id = $2 AND c.id = ANY($3::uuid[]) AND c.erased_at IS NULL
                 ON CONFLICT DO NOTHING`,
                [id, auth.organisationId, candidateIds],
              )
            : await tx.query('DELETE FROM candidate_group_members WHERE group_id = $1 AND candidate_id = ANY($2::uuid[])', [id, candidateIds]);
        await audit(tx, { ...auditFrom(req), action: `group.${action}`, targetType: 'group', targetId: id, data: { count: changed } });
        return { [action === 'add' ? 'added' : 'removed']: changed ?? 0 };
      });
    });
  }

  // Issues a new access code for one candidate's exam, replacing any earlier
  // one. It is shown once: only its hash is kept.
  app.post('/assignments/:id/access-code', { preHandler: authorize('session:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ allowed: boolean; status: string; candidate_status: string; identity_status: string; has_account: boolean; ends_at: Date }>(
        `SELECT o.allow_access_codes AS allowed, a.status, c.status AS candidate_status, c.identity_status, c.user_id IS NOT NULL AS has_account, s.ends_at
           FROM exam_assignments a JOIN organisations o ON o.id = a.organisation_id
           JOIN candidates c ON c.id = a.candidate_id JOIN sessions s ON s.id = a.session_id
          WHERE a.id = $1 AND a.organisation_id = $2 FOR UPDATE OF a`,
        [id, auth.organisationId],
      );
      const a = rows[0];
      if (!a) throw notFound('Assignment');
      if (!a.allowed) throw conflict('Access codes are turned off for this organisation. The owner can turn them on under Staff, Security.');
      if (a.candidate_status !== 'approved' || a.identity_status !== 'verified') throw conflict('Access codes are only for approved candidates whose identity is verified');
      if (!a.has_account) throw conflict('The candidate must have accepted their invitation first');
      if (!['assigned', 'precheck_complete', 'active'].includes(a.status)) throw conflict(`This exam is ${a.status}`);
      const code = newAccessCode();
      await tx.query('UPDATE exam_assignments SET access_code_hash = $2, access_code_issued_at = now() WHERE id = $1', [id, hashAccessCode(code)]);
      await audit(tx, { ...auditFrom(req), action: 'access_code.issue', targetType: 'exam_assignment', targetId: id });
      return { code, validUntil: a.ends_at };
    });
  });

  app.delete('/assignments/:id/access-code', { preHandler: authorize('session:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query('UPDATE exam_assignments SET access_code_hash = NULL, access_code_issued_at = NULL WHERE id = $1 AND organisation_id = $2', [
        id,
        auth.organisationId,
      ]);
      if (!rowCount) throw notFound('Assignment');
      await audit(tx, { ...auditFrom(req), action: 'access_code.revoke', targetType: 'exam_assignment', targetId: id });
      return { revoked: true };
    });
  });

  // Branding: a logo, uploaded as the raw image.
  app.addContentTypeParser(['image/png', 'image/jpeg'], { parseAs: 'buffer', bodyLimit: MAX_LOGO_BYTES }, (_req, body, done) => done(null, body));

  app.put('/organisations/:id/logo', { preHandler: authorize('organisation:manage_security') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    if (id !== auth.organisationId) throw notFound('Organisation');
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Send a PNG or JPEG image');
    const type = imageType(body);
    if (!type) throw badRequest('The logo must be a PNG or JPEG image');
    const key = `branding/${id}/logo`;
    await deps.store!.put(key, body);
    await withTransaction(db, async (tx) => {
      await tx.query('UPDATE organisations SET logo_key = $2, logo_type = $3 WHERE id = $1', [id, key, type]);
      await audit(tx, { ...auditFrom(req), action: 'organisation.logo', targetType: 'organisation', targetId: id, data: { bytes: body.length } });
    });
    return { logo: true };
  });

  app.delete('/organisations/:id/logo', { preHandler: authorize('organisation:manage_security') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    if (id !== auth.organisationId) throw notFound('Organisation');
    const { rows } = await db.query<{ logo_key: string | null }>('SELECT logo_key FROM organisations WHERE id = $1', [id]);
    await db.query('UPDATE organisations SET logo_key = NULL, logo_type = NULL WHERE id = $1', [id]);
    if (rows[0]?.logo_key) await deps.store!.delete(rows[0].logo_key);
    await withTransaction(db, (tx) => audit(tx, { ...auditFrom(req), action: 'organisation.logo_removed', targetType: 'organisation', targetId: id }));
    return { logo: false };
  });

  // Public: what the sign in screen shows once a candidate types their organisation.
  app.get('/public/organisations/:slug/branding', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { slug } = parse(slugParams, req.params);
    const { rows } = await db.query<{ name: string; colour: string | null; logo: boolean; access_codes: boolean }>(
      `SELECT name, brand_colour AS colour, logo_key IS NOT NULL AS logo, allow_access_codes AS access_codes FROM organisations WHERE slug = $1`,
      [slug],
    );
    if (!rows[0]) throw notFound('Organisation');
    // Single sign on buttons, for the sign in screens.
    const { rows: sso } = await db.query(
      `SELECT p.id, p.name, p.for_staff AS "forStaff", p.for_candidates AS "forCandidates"
         FROM identity_providers p JOIN organisations o ON o.id = p.organisation_id WHERE o.slug = $1 AND p.enabled ORDER BY p.created_at`,
      [slug],
    );
    return { name: rows[0].name, colour: rows[0].colour, logo: rows[0].logo, accessCodes: rows[0].access_codes, sso };
  });

  // The signed in person's own organisation, so every screen after sign in
  // (exams included) carries its name, logo and colour.
  app.get('/me/branding', async (req) => {
    const auth = requireOrg(req);
    const { rows } = await db.query<{ slug: string; name: string; colour: string | null; logo: boolean }>(
      'SELECT slug, name, brand_colour AS colour, logo_key IS NOT NULL AS logo FROM organisations WHERE id = $1',
      [auth.organisationId],
    );
    if (!rows[0]) throw notFound('Organisation');
    return rows[0];
  });

  app.get('/public/organisations/:slug/logo', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { slug } = parse(slugParams, req.params);
    const { rows } = await db.query<{ logo_key: string | null; logo_type: string | null }>('SELECT logo_key, logo_type FROM organisations WHERE slug = $1', [slug]);
    const object = rows[0]?.logo_key ? await deps.store!.get(rows[0].logo_key) : null;
    if (!object) throw notFound('Logo');
    return reply
      .header('content-type', rows[0]!.logo_type!)
      .header('content-length', object.size)
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .send(object.stream);
  });
}
