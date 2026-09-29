import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { withTransaction } from '../db.js';
import { unauthorized } from '../errors.js';
import { parse } from '../validation.js';
import { hashToken, newOpaqueToken, verifyPassword } from '../auth/passwords.js';
import { signAccessToken } from '../auth/tokens.js';
import { requireAuth } from '../auth/context.js';
import { audit } from '../audit.js';
import type { Queryable } from '../db.js';

const loginBody = z.object({
  /** Organisation slug. Omit only for platform super admins. */
  organisation: z.string().min(1).optional(),
  email: z.email(),
  password: z.string().min(1).max(1024),
});

const refreshBody = z.object({ refreshToken: z.string().min(1) });

// One message for every failure so responses do not reveal which emails exist.
const INVALID = 'Invalid organisation, email or password';

async function issueTokens(q: Queryable, deps: AppDeps, userId: string, organisationId: string | null) {
  const accessToken = await signAccessToken(deps.config, { sub: userId, org: organisationId });
  let refreshToken: string | null = null;
  if (organisationId) {
    const { token, hash } = newOpaqueToken();
    await q.query(
      `INSERT INTO refresh_tokens (user_id, organisation_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [userId, organisationId, hash, deps.config.refreshTokenTtlSeconds],
    );
    refreshToken = token;
  }
  return { accessToken, refreshToken, expiresIn: deps.config.accessTokenTtlSeconds };
}

export async function authRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const authRateLimit = { rateLimit: { max: deps.config.authRateLimitPerMinute, timeWindow: '1 minute' } };

  app.post('/auth/login', { config: authRateLimit }, async (req) => {
    const body = parse(loginBody, req.body);

    const { rows } = await db.query<{ id: string; password_hash: string | null; platform_role: string | null }>(
      'SELECT id, password_hash, platform_role FROM users WHERE lower(email) = lower($1)',
      [body.email],
    );
    const user = rows[0];
    if (!user || !(await verifyPassword(body.password, user.password_hash))) throw unauthorized(INVALID);

    let organisationId: string | null = null;
    if (body.organisation) {
      const { rows: orgs } = await db.query<{ id: string }>(
        `SELECT o.id FROM organisations o
          WHERE o.slug = $1 AND (
            EXISTS (SELECT 1 FROM organisation_users ou
                     WHERE ou.organisation_id = o.id AND ou.user_id = $2 AND ou.status = 'active')
            OR EXISTS (SELECT 1 FROM candidates c
                     WHERE c.organisation_id = o.id AND c.user_id = $2 AND c.status NOT IN ('rejected', 'blocked')))`,
        [body.organisation, user.id],
      );
      organisationId = orgs[0]?.id ?? null;
      if (!organisationId) throw unauthorized(INVALID);
    } else if (user.platform_role !== 'super_admin') {
      throw unauthorized(INVALID);
    }

    return withTransaction(db, async (tx) => {
      await audit(tx, { organisationId, actorUserId: user.id, action: 'auth.login', ip: req.ip });
      return issueTokens(tx, deps, user.id, organisationId);
    });
  });

  // Refresh tokens rotate on every use. Presenting an already-rotated token is
  // treated as theft and revokes the whole chain for that user/organisation.
  app.post('/auth/refresh', { config: authRateLimit }, async (req) => {
    const body = parse(refreshBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        user_id: string;
        organisation_id: string;
        revoked_at: Date | null;
        expired: boolean;
      }>(
        `SELECT id, user_id, organisation_id, revoked_at, expires_at < now() AS expired
           FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [hashToken(body.refreshToken)],
      );
      const token = rows[0];
      if (!token) throw unauthorized('Invalid refresh token');

      if (token.revoked_at) {
        await tx.query(
          `UPDATE refresh_tokens SET revoked_at = now()
            WHERE user_id = $1 AND organisation_id = $2 AND revoked_at IS NULL`,
          [token.user_id, token.organisation_id],
        );
        await audit(tx, {
          organisationId: token.organisation_id,
          actorUserId: token.user_id,
          action: 'auth.refresh_reuse_detected',
          ip: req.ip,
        });
        return null;
      }
      if (token.expired) throw unauthorized('Refresh token expired');

      const issued = await issueTokens(tx, deps, token.user_id, token.organisation_id);
      await tx.query(
        `UPDATE refresh_tokens SET revoked_at = now(),
                replaced_by = (SELECT id FROM refresh_tokens WHERE token_hash = $2)
          WHERE id = $1`,
        [token.id, hashToken(issued.refreshToken!)],
      );
      return issued;
    }).then((result) => {
      // Thrown outside the transaction so the chain revocation above is committed.
      if (!result) throw unauthorized('Invalid refresh token');
      return result;
    });
  });

  app.post('/auth/logout', async (req, reply) => {
    const body = parse(refreshBody, req.body);
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
      hashToken(body.refreshToken),
    ]);
    return reply.code(204).send();
  });

  app.get('/me', async (req) => {
    const auth = requireAuth(req);
    const { rows } = await db.query<{ id: string; email: string; display_name: string }>(
      'SELECT id, email, display_name FROM users WHERE id = $1',
      [auth.userId],
    );
    return {
      user: rows[0],
      organisationId: auth.organisationId,
      isSuperAdmin: auth.isSuperAdmin,
      candidateId: auth.candidateId,
      permissions: [...auth.permissions].sort(),
    };
  });
}
