import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { type Tx, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { authorize, requireOrg } from '../auth/context.js';
import { hashPassword, hashToken, newOpaqueToken, verifyPassword } from '../auth/passwords.js';
import { audit, auditFrom } from '../audit.js';
import { notify } from '../notifications.js';
import {
  type CandidateAction,
  type CandidateStatus,
  type IdentityStatus,
  selfRegistrationOutcome,
  transition,
} from '../candidateStatus.js';
import { idParams, page, pagination, parse, password } from '../validation.js';

const candidateInput = z.object({
  email: z.email(),
  fullName: z.string().min(1).max(200),
  studentId: z.string().max(100).optional(),
  programme: z.string().max(200).optional(),
});

const importBody = z.object({ candidates: z.array(candidateInput).min(1).max(1000) });

const listQuery = pagination.extend({
  status: z.enum(['invited', 'registered', 'pending_approval', 'approved', 'rejected', 'blocked']).optional(),
});

const actionBody = z.object({ reason: z.string().max(1000).optional() }).default({});

const acceptInvitationBody = z.object({
  token: z.string().min(1),
  password,
  displayName: z.string().min(1).max(200).optional(),
});

const selfRegisterBody = candidateInput.extend({ password });

const verifyEmailBody = z.object({ token: z.string().min(1) });

const requestVerificationBody = z.object({ message: z.string().min(1).max(2000) });

const CANDIDATE_COLUMNS = `id, email, full_name AS "fullName", student_id AS "studentId", programme, status,
  identity_status AS "identityStatus", user_id AS "userId", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function candidateRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;
  const publicRateLimit = { rateLimit: { max: config.authRateLimitPerMinute, timeWindow: '1 minute' } };

  async function issueToken(tx: Tx, organisationId: string, candidateId: string, purpose: 'invitation' | 'email_verification') {
    const { token, hash } = newOpaqueToken();
    await tx.query(
      `INSERT INTO candidate_tokens (organisation_id, candidate_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
      [organisationId, candidateId, purpose, hash, config.invitationTtlHours],
    );
    return token;
  }

  async function invite(tx: Tx, req: FastifyRequest, organisationId: string, c: z.infer<typeof candidateInput>) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO candidates (organisation_id, email, full_name, student_id, programme, status)
       VALUES ($1, $2, $3, $4, $5, 'invited')
       ON CONFLICT (organisation_id, lower(email)) DO NOTHING
       RETURNING id`,
      [organisationId, c.email, c.fullName, c.studentId ?? null, c.programme ?? null],
    );
    const candidateId = rows[0]?.id;
    if (!candidateId) return null;

    const token = await issueToken(tx, organisationId, candidateId, 'invitation');
    // The delivery worker must clear the link from the payload once the email is sent.
    await notify(tx, {
      organisationId,
      kind: 'candidate_invitation',
      channel: 'email',
      recipientEmail: c.email,
      payload: { link: `${config.publicBaseUrl}/invitation/${token}`, fullName: c.fullName },
    });
    await audit(tx, {
      ...auditFrom(req),
      action: 'candidate.invite',
      targetType: 'candidate',
      targetId: candidateId,
      data: { email: c.email },
    });
    return candidateId;
  }

  /** Consume a single-use token, locking it so concurrent use cannot succeed twice. */
  async function consumeToken(tx: Tx, token: string, purpose: 'invitation' | 'email_verification') {
    const { rows } = await tx.query<{ id: string; organisation_id: string; candidate_id: string }>(
      `SELECT id, organisation_id, candidate_id FROM candidate_tokens
        WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [hashToken(token), purpose],
    );
    const row = rows[0];
    if (!row) throw badRequest('This link is invalid or has expired');
    await tx.query('UPDATE candidate_tokens SET used_at = now() WHERE id = $1', [row.id]);
    return row;
  }

  /**
   * Link a candidate to a user account. An existing account is only linked if
   * the caller proves they own it, so a registration cannot hijack an account.
   */
  async function linkUser(tx: Tx, email: string, displayName: string, pw: string): Promise<string> {
    const { rows } = await tx.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    const existing = rows[0];
    if (existing) {
      if (!(await verifyPassword(pw, existing.password_hash))) {
        throw conflict('An account with this email already exists; use its password to continue');
      }
      return existing.id;
    }
    const { rows: created } = await tx.query<{ id: string }>(
      'INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [email, displayName, await hashPassword(pw)],
    );
    return created[0]!.id;
  }

  // ---- Staff endpoints -----------------------------------------------------

  app.post('/candidates/invite', { preHandler: authorize('candidate:invite') }, async (req, reply) => {
    const auth = requireOrg(req);
    const body = parse(candidateInput, req.body);
    const id = await withTransaction(db, (tx) => invite(tx, req, auth.organisationId, body));
    if (!id) throw conflict('A candidate with this email already exists in the organisation');
    return reply.code(201).send({ id, status: 'invited' });
  });

  app.post('/candidates/import', { preHandler: authorize('candidate:invite') }, async (req) => {
    const auth = requireOrg(req);
    const body = parse(importBody, req.body);
    return withTransaction(db, async (tx) => {
      const created: string[] = [];
      const skipped: string[] = [];
      for (const c of body.candidates) {
        const id = await invite(tx, req, auth.organisationId, c);
        if (id) created.push(id);
        else skipped.push(c.email);
      }
      return { created: created.length, skipped };
    });
  });

  app.get('/candidates', { preHandler: authorize('candidate:view') }, async (req) => {
    const auth = requireOrg(req);
    const { limit, offset, status } = parse(listQuery, req.query);
    const { rows } = await db.query(
      `SELECT ${CANDIDATE_COLUMNS} FROM candidates
        WHERE organisation_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at, id LIMIT $3 OFFSET $4`,
      [auth.organisationId, status ?? null, limit, offset],
    );
    return page(rows, limit, offset);
  });

  app.get('/candidates/:id', { preHandler: authorize('candidate:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query(`SELECT ${CANDIDATE_COLUMNS} FROM candidates WHERE id = $1 AND organisation_id = $2`, [
      id,
      auth.organisationId,
    ]);
    if (!rows[0]) throw notFound('Candidate');
    const { rows: assignments } = await db.query(
      `SELECT a.id, a.status, s.id AS "sessionId", s.name AS "sessionName", s.starts_at AS "startsAt"
         FROM exam_assignments a JOIN sessions s ON s.id = a.session_id
        WHERE a.candidate_id = $1 AND a.organisation_id = $2
        ORDER BY s.starts_at`,
      [id, auth.organisationId],
    );
    return { ...rows[0], assignments };
  });

  for (const action of ['approve', 'reject', 'block', 'unblock'] as const satisfies readonly CandidateAction[]) {
    app.post(`/candidates/:id/${action}`, { preHandler: authorize('candidate:approve') }, async (req) => {
      const auth = requireOrg(req);
      const { id } = parse(idParams, req.params);
      const { reason } = parse(actionBody, req.body ?? {});

      return withTransaction(db, async (tx) => {
        const { rows } = await tx.query<{
          status: CandidateStatus;
          identity_status: IdentityStatus;
          email: string;
          user_id: string | null;
        }>(
          `SELECT status, identity_status, email, user_id FROM candidates
            WHERE id = $1 AND organisation_id = $2 FOR UPDATE`,
          [id, auth.organisationId],
        );
        const candidate = rows[0];
        if (!candidate) throw notFound('Candidate');

        const result = transition(action, { status: candidate.status, identityStatus: candidate.identity_status });
        if (!result.ok) throw conflict(result.reason);

        // Approving a manually reviewed candidate records that staff verified their identity.
        const identity = action === 'approve' ? 'verified' : candidate.identity_status;
        await tx.query(
          `UPDATE candidates SET status = $3, identity_status = $4, updated_at = now()
            WHERE id = $1 AND organisation_id = $2`,
          [id, auth.organisationId, result.to, identity],
        );
        if (action === 'block' || action === 'reject') {
          // Blocking or rejecting withdraws any entitlement that has not been used yet.
          await tx.query(
            `UPDATE exam_assignments SET status = 'revoked'
              WHERE candidate_id = $1 AND organisation_id = $2 AND status IN ('assigned', 'precheck_complete')`,
            [id, auth.organisationId],
          );
        }
        if (action === 'approve' || action === 'reject') {
          await notify(tx, {
            organisationId: auth.organisationId,
            kind: action === 'approve' ? 'candidate_approved' : 'candidate_rejected',
            channel: 'email',
            recipientUserId: candidate.user_id,
            recipientEmail: candidate.email,
            payload: reason ? { reason } : {},
          });
        }
        await audit(tx, {
          ...auditFrom(req),
          action: `candidate.${action}`,
          targetType: 'candidate',
          targetId: id,
          data: { from: candidate.status, to: result.to, ...(reason ? { reason } : {}) },
        });
        return { id, status: result.to, identityStatus: identity };
      });
    });
  }

  app.post('/candidates/:id/request-verification', { preHandler: authorize('candidate:approve') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { message } = parse(requestVerificationBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ status: CandidateStatus; email: string; user_id: string | null }>(
        'SELECT status, email, user_id FROM candidates WHERE id = $1 AND organisation_id = $2 FOR UPDATE',
        [id, auth.organisationId],
      );
      const candidate = rows[0];
      if (!candidate) throw notFound('Candidate');
      if (candidate.status !== 'pending_approval') throw conflict('Candidate is not awaiting approval');

      await tx.query(
        `UPDATE candidates SET identity_status = 'manual_review', updated_at = now()
          WHERE id = $1 AND organisation_id = $2`,
        [id, auth.organisationId],
      );
      await notify(tx, {
        organisationId: auth.organisationId,
        kind: 'candidate_verification_requested',
        channel: 'email',
        recipientUserId: candidate.user_id,
        recipientEmail: candidate.email,
        payload: { message },
      });
      await audit(tx, { ...auditFrom(req), action: 'candidate.request_verification', targetType: 'candidate', targetId: id });
      return { id, status: candidate.status, identityStatus: 'manual_review' };
    });
  });

  // ---- Public onboarding endpoints -------------------------------------------

  app.post('/public/invitations/accept', { config: publicRateLimit }, async (req) => {
    const body = parse(acceptInvitationBody, req.body);
    return withTransaction(db, async (tx) => {
      const token = await consumeToken(tx, body.token, 'invitation');
      const { rows } = await tx.query<{ email: string; full_name: string; status: CandidateStatus }>(
        'SELECT email, full_name, status FROM candidates WHERE id = $1 FOR UPDATE',
        [token.candidate_id],
      );
      const candidate = rows[0]!;
      if (candidate.status !== 'invited') throw conflict('This invitation has already been used');

      const userId = await linkUser(tx, candidate.email, body.displayName ?? candidate.full_name, body.password);
      // Following the emailed link proves mailbox ownership.
      await tx.query(
        `UPDATE candidates SET user_id = $2, status = 'pending_approval', identity_status = 'verified', updated_at = now()
          WHERE id = $1`,
        [token.candidate_id, userId],
      );
      await audit(tx, {
        organisationId: token.organisation_id,
        actorUserId: userId,
        action: 'candidate.invitation_accepted',
        targetType: 'candidate',
        targetId: token.candidate_id,
        ip: req.ip,
      });
      return { candidateId: token.candidate_id, status: 'pending_approval' };
    });
  });

  app.post('/public/organisations/:slug/register', { config: publicRateLimit }, async (req, reply) => {
    const { slug } = parse(z.object({ slug: z.string() }), req.params);
    const body = parse(selfRegisterBody, req.body);

    const result = await withTransaction(db, async (tx) => {
      const { rows: orgs } = await tx.query<{ id: string; approved_email_domains: string[] }>(
        'SELECT id, approved_email_domains FROM organisations WHERE slug = $1',
        [slug],
      );
      const org = orgs[0];
      if (!org) throw notFound('Organisation');

      const outcome = selfRegistrationOutcome(body.email, org.approved_email_domains);
      const userId = await linkUser(tx, body.email, body.fullName, body.password);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO candidates (organisation_id, user_id, email, full_name, student_id, programme, status, identity_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organisation_id, lower(email)) DO NOTHING
         RETURNING id`,
        [org.id, userId, body.email, body.fullName, body.studentId ?? null, body.programme ?? null, outcome.status, outcome.identityStatus],
      );
      const candidateId = rows[0]?.id;
      if (!candidateId) throw conflict('This email is already registered or invited; check your inbox for an invitation');

      if (outcome.identityStatus === 'email_pending') {
        const token = await issueToken(tx, org.id, candidateId, 'email_verification');
        await notify(tx, {
          organisationId: org.id,
          kind: 'candidate_email_verification',
          channel: 'email',
          recipientEmail: body.email,
          payload: { link: `${config.publicBaseUrl}/verify-email/${token}` },
        });
      }
      await audit(tx, {
        organisationId: org.id,
        actorUserId: userId,
        action: 'candidate.self_register',
        targetType: 'candidate',
        targetId: candidateId,
        data: outcome,
        ip: req.ip,
      });
      return { candidateId, ...outcome };
    });
    return reply.code(201).send(result);
  });

  app.post('/public/verify-email', { config: publicRateLimit }, async (req) => {
    const body = parse(verifyEmailBody, req.body);
    return withTransaction(db, async (tx) => {
      const token = await consumeToken(tx, body.token, 'email_verification');
      const { rows } = await tx.query<{ status: CandidateStatus; user_id: string | null }>(
        `UPDATE candidates
            SET identity_status = 'verified',
                status = CASE WHEN status = 'registered' THEN 'pending_approval' ELSE status END,
                updated_at = now()
          WHERE id = $1
          RETURNING status, user_id`,
        [token.candidate_id],
      );
      await audit(tx, {
        organisationId: token.organisation_id,
        actorUserId: rows[0]!.user_id,
        action: 'candidate.email_verified',
        targetType: 'candidate',
        targetId: token.candidate_id,
        ip: req.ip,
      });
      return { candidateId: token.candidate_id, status: rows[0]!.status, identityStatus: 'verified' };
    });
  });
}
