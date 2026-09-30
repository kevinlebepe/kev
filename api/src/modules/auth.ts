import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashAccessCode } from '../accessCodes.js';
import type { AppDeps } from '../context.js';
import { withTransaction } from '../db.js';
import { unauthorized } from '../errors.js';
import { parse } from '../validation.js';
import { hashPassword, hashToken, newOpaqueToken, verifyPassword } from '../auth/passwords.js';
import { signAccessToken, signMfaToken, verifyMfaToken } from '../auth/tokens.js';
import { requireAuth } from '../auth/context.js';
import { newRecoveryCodes, newTotpSecret, openSecret, otpauthUrl, sealSecret, verifyTotp } from '../auth/totp.js';
import { audit } from '../audit.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import { notify } from '../notifications.js';
import { consumeUserToken, issueUserToken, PASSWORD_RESET_TTL_HOURS } from '../userTokens.js';
import { password as passwordRule } from '../validation.js';

const loginBody = z.object({
  /** Organisation slug. Omit only for platform super admins. */
  organisation: z.string().min(1).optional(),
  email: z.email(),
  password: z.string().min(1).max(1024),
});

const refreshBody = z.object({ refreshToken: z.string().min(1) });

// One message for every failure, locked accounts included, so responses do
// not reveal which emails exist or which accounts are locked.
const INVALID = 'Sign in failed. Check the organisation, email and password. After 5 failed tries an account is locked for 15 minutes.';

/** Wrong passwords or codes in a row before the account locks. */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;

const mfaBody = z.object({ mfaToken: z.string().min(1), code: z.string().trim().min(6).max(20) });
const codeBody = z.object({ code: z.string().trim().min(6).max(20) });
const resetRequestBody = z.object({ email: z.email(), app: z.enum(['candidate', 'staff']).default('candidate') });
const setPasswordBody = z.object({ token: z.string().min(1), password: passwordRule });

/** Counts a failed password or code, locking the account at the threshold. Committed even though the request fails. */
async function recordFailure(q: Queryable, userId: string, ip: string): Promise<void> {
  const { rows } = await q.query<{ locked: boolean }>(
    `UPDATE users SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                      locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
      WHERE id = $1 RETURNING locked_until > now() AS locked`,
    [userId, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES],
  );
  await audit(q, { organisationId: null, actorUserId: userId, action: rows[0]?.locked ? 'auth.locked' : 'auth.login_failed', ip });
}

const accessCodeBody = z.object({ organisation: z.string().trim().min(1).max(100), code: z.string().trim().min(8).max(40) });

const hashCode = (code: string) => hashToken(code.toLowerCase().replace(/\s/g, ''));

/** `until` caps the session, for a sign in that only holds for one exam. */
async function issueTokens(q: Queryable, deps: AppDeps, userId: string, organisationId: string | null, until: Date | null = null) {
  const accessToken = await signAccessToken(deps.config, { sub: userId, org: organisationId });
  let refreshToken: string | null = null;
  if (organisationId) {
    const { token, hash } = newOpaqueToken();
    await q.query(
      `INSERT INTO refresh_tokens (user_id, organisation_id, token_hash, expires_at, hard_expires_at)
       VALUES ($1, $2, $3, LEAST(now() + make_interval(secs => $4), $5::timestamptz), $5::timestamptz)`,
      [userId, organisationId, hash, deps.config.refreshTokenTtlSeconds, until],
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

    const { rows } = await db.query<{ id: string; password_hash: string | null; platform_role: string | null; locked: boolean; mfa_enabled: boolean }>(
      'SELECT id, password_hash, platform_role, coalesce(locked_until > now(), false) AS locked, mfa_enabled FROM users WHERE lower(email) = lower($1)',
      [body.email],
    );
    const user = rows[0];
    if (!user) throw unauthorized(INVALID);
    // While locked, even the right password is refused, or guessing would carry on.
    if (user.locked) throw unauthorized(INVALID);
    if (!(await verifyPassword(body.password, user.password_hash))) {
      await recordFailure(db, user.id, req.ip);
      throw unauthorized(INVALID);
    }

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

    // With two factor sign in the password alone earns only a short lived
    // ticket for the second step. The failure count is kept until that step
    // succeeds, so knowing the password does not allow unlimited code guesses.
    if (user.mfa_enabled) return { mfaRequired: true, mfaToken: await signMfaToken(deps.config, { sub: user.id, org: organisationId }) };
    await db.query('UPDATE users SET failed_logins = 0 WHERE id = $1', [user.id]);

    return withTransaction(db, async (tx) => {
      await audit(tx, { organisationId, actorUserId: user.id, action: 'auth.login', ip: req.ip });
      return issueTokens(tx, deps, user.id, organisationId);
    });
  });

  // Exam access code (spec section 3): a controlled fallback for an approved,
  // verified candidate who cannot sign in the usual way on exam day. It works
  // only if the organisation allows it, only from an hour before the session
  // until it ends, and the session it opens ends with the exam.
  app.post('/auth/access-code', { config: authRateLimit }, async (req) => {
    const body = parse(accessCodeBody, req.body);
    const { rows } = await db.query<{ assignment_id: string; organisation_id: string; user_id: string | null; ends_at: Date }>(
      `SELECT a.id AS assignment_id, a.organisation_id, c.user_id, s.ends_at
         FROM exam_assignments a
         JOIN organisations o ON o.id = a.organisation_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN sessions s ON s.id = a.session_id
        WHERE a.access_code_hash = $1 AND o.slug = $2 AND o.allow_access_codes
          AND c.status = 'approved' AND c.identity_status = 'verified' AND c.erased_at IS NULL
          AND a.status IN ('assigned', 'precheck_complete', 'active')
          AND s.status IN ('scheduled', 'open')
          AND now() BETWEEN s.starts_at - interval '60 minutes' AND s.ends_at`,
      [hashAccessCode(body.code), body.organisation],
    );
    const found = rows[0];
    if (!found?.user_id) {
      await withTransaction(db, (tx) => audit(tx, { organisationId: null, actorUserId: null, action: 'auth.access_code_failed', ip: req.ip }));
      throw unauthorized('That code is not valid for this organisation right now. Check it, or contact exam support.');
    }
    return withTransaction(db, async (tx) => {
      await audit(tx, {
        organisationId: found.organisation_id,
        actorUserId: found.user_id,
        action: 'auth.access_code',
        targetType: 'exam_assignment',
        targetId: found.assignment_id,
        ip: req.ip,
      });
      return issueTokens(tx, deps, found.user_id!, found.organisation_id, found.ends_at);
    });
  });

  // The second step: a code from the authenticator app, or a recovery code.
  app.post('/auth/mfa', { config: authRateLimit }, async (req) => {
    const body = parse(mfaBody, req.body);
    const claims = await verifyMfaToken(deps.config, body.mfaToken);
    if (!claims) throw unauthorized('The sign in took too long. Start again.');
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ totp_secret: string | null; totp_last_step: string | null; locked: boolean }>(
        'SELECT totp_secret, totp_last_step, coalesce(locked_until > now(), false) AS locked FROM users WHERE id = $1 FOR UPDATE',
        [claims.sub],
      );
      const user = rows[0];
      if (!user?.totp_secret || user.locked) return null;
      const step = verifyTotp(openSecret(user.totp_secret, deps.config.jwtSecret), body.code, {
        lastStep: user.totp_last_step === null ? null : Number(user.totp_last_step),
      });
      let method = 'totp';
      if (step !== null) {
        await tx.query('UPDATE users SET totp_last_step = $2, failed_logins = 0 WHERE id = $1', [claims.sub, step]);
      } else {
        const { rowCount } = await tx.query(
          'UPDATE user_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
          [claims.sub, hashCode(body.code)],
        );
        if (!rowCount) {
          await recordFailure(tx, claims.sub, req.ip);
          return null;
        }
        method = 'recovery_code';
        await tx.query('UPDATE users SET failed_logins = 0 WHERE id = $1', [claims.sub]);
      }
      await audit(tx, { organisationId: claims.org, actorUserId: claims.sub, action: 'auth.login', ip: req.ip, data: { mfa: method } });
      return issueTokens(tx, deps, claims.sub, claims.org);
    }).then((result) => {
      // Thrown after the transaction, so a failure is still counted.
      if (!result) throw unauthorized('That code is not right. After 5 failed tries the account is locked for 15 minutes.');
      return result;
    });
  });

  // ---- Two factor enrolment -------------------------------------------------

  app.post('/me/mfa/setup', async (req) => {
    const auth = requireAuth(req);
    const { rows } = await db.query<{ email: string; mfa_enabled: boolean }>('SELECT email, mfa_enabled FROM users WHERE id = $1', [auth.userId]);
    if (rows[0]!.mfa_enabled) throw conflict('Two factor sign in is already on');
    const secret = newTotpSecret();
    await db.query('UPDATE users SET totp_pending = $2 WHERE id = $1', [auth.userId, sealSecret(secret, deps.config.jwtSecret)]);
    return { secret, otpauthUrl: otpauthUrl(secret, rows[0]!.email) };
  });

  app.post('/me/mfa/enable', async (req) => {
    const auth = requireAuth(req);
    const { code } = parse(codeBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ totp_pending: string | null; mfa_enabled: boolean }>(
        'SELECT totp_pending, mfa_enabled FROM users WHERE id = $1 FOR UPDATE',
        [auth.userId],
      );
      if (rows[0]!.mfa_enabled) throw conflict('Two factor sign in is already on');
      if (!rows[0]!.totp_pending) throw badRequest('Start the set up first');
      const step = verifyTotp(openSecret(rows[0]!.totp_pending, deps.config.jwtSecret), code);
      if (step === null) throw badRequest('That code is not right. Check the time on your phone and try the next code.');
      await tx.query(
        'UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = $2, mfa_enabled = true WHERE id = $1',
        [auth.userId, step],
      );
      const recoveryCodes = newRecoveryCodes();
      await tx.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [auth.userId]);
      for (const c of recoveryCodes) await tx.query('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [auth.userId, hashCode(c)]);
      await audit(tx, { organisationId: auth.organisationId, actorUserId: auth.userId, action: 'auth.mfa_enabled', ip: req.ip });
      return { enabled: true, recoveryCodes };
    });
  });

  app.post('/me/mfa/disable', async (req) => {
    const auth = requireAuth(req);
    const { code } = parse(codeBody, req.body);
    if (auth.mfaRequiredByOrganisation) throw conflict('Your organisation requires two factor sign in for staff');
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ totp_secret: string | null }>('SELECT totp_secret FROM users WHERE id = $1 FOR UPDATE', [auth.userId]);
      if (!rows[0]!.totp_secret) throw conflict('Two factor sign in is not on');
      const ok =
        verifyTotp(openSecret(rows[0]!.totp_secret, deps.config.jwtSecret), code) !== null ||
        Boolean((await tx.query('SELECT 1 FROM user_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL', [auth.userId, hashCode(code)])).rowCount);
      if (!ok) throw badRequest('That code is not right');
      await tx.query('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, mfa_enabled = false WHERE id = $1', [auth.userId]);
      await tx.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [auth.userId]);
      await audit(tx, { organisationId: auth.organisationId, actorUserId: auth.userId, action: 'auth.mfa_disabled', ip: req.ip });
      return { enabled: false };
    });
  });

  // ---- Emailed links ------------------------------------------------------

  // Always answers the same way, so it cannot be used to find out who has an account.
  app.post('/public/password-reset', { config: authRateLimit }, async (req, reply) => {
    const body = parse(resetRequestBody, req.body);
    await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE lower(email) = lower($1)', [body.email]);
      const user = rows[0];
      if (!user) return;
      const token = await issueUserToken(tx, user.id, 'password_reset', PASSWORD_RESET_TTL_HOURS);
      const base = body.app === 'staff' ? `${deps.config.portalBaseUrl}/#/reset` : `${deps.config.publicBaseUrl}/reset-password`;
      await notify(tx, {
        organisationId: null,
        kind: 'password_reset',
        channel: 'email',
        recipientUserId: user.id,
        recipientEmail: user.email,
        payload: { link: `${base}/${token}` },
      });
      await audit(tx, { organisationId: null, actorUserId: user.id, action: 'auth.password_reset_requested', ip: req.ip });
    });
    return reply.code(202).send({ message: 'If an account uses that email, a link to choose a new password is on its way.' });
  });

  app.post('/public/password-reset/complete', { config: authRateLimit }, async (req) => {
    const body = parse(setPasswordBody, req.body);
    return withTransaction(db, async (tx) => {
      const userId = await consumeUserToken(tx, body.token, 'password_reset');
      await tx.query('UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1', [userId, await hashPassword(body.password)]);
      // Anyone signed in with the old password is signed out everywhere.
      await tx.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await audit(tx, { organisationId: null, actorUserId: userId, action: 'auth.password_reset', ip: req.ip });
      return { reset: true };
    });
  });

  app.post('/public/staff-invitations/accept', { config: authRateLimit }, async (req) => {
    const body = parse(setPasswordBody, req.body);
    return withTransaction(db, async (tx) => {
      const userId = await consumeUserToken(tx, body.token, 'staff_invitation');
      const { rows } = await tx.query<{ email: string; slug: string | null }>(
        `SELECT u.email, (SELECT o.slug FROM organisation_users ou JOIN organisations o ON o.id = ou.organisation_id
                           WHERE ou.user_id = u.id ORDER BY ou.created_at DESC LIMIT 1) AS slug
           FROM users u WHERE u.id = $1`,
        [userId],
      );
      await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await hashPassword(body.password)]);
      await audit(tx, { organisationId: null, actorUserId: userId, action: 'auth.staff_invitation_accepted', ip: req.ip });
      return { email: rows[0]!.email, organisation: rows[0]!.slug };
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
        hard_expires_at: Date | null;
      }>(
        `SELECT id, user_id, organisation_id, revoked_at, expires_at < now() AS expired, hard_expires_at
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

      const issued = await issueTokens(tx, deps, token.user_id, token.organisation_id, token.hard_expires_at);
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
    const { rows: mfa } = await db.query<{ mfa_enabled: boolean }>('SELECT mfa_enabled FROM users WHERE id = $1', [auth.userId]);
    return {
      user: rows[0],
      mfaEnabled: mfa[0]!.mfa_enabled,
      // Staff of an organisation that requires two factor sign in get no staff access until they turn it on.
      mfaSetupRequired: auth.mfaSetupRequired,
      mfaRequiredByOrganisation: auth.mfaRequiredByOrganisation,
      organisationId: auth.organisationId,
      isSuperAdmin: auth.isSuperAdmin,
      candidateId: auth.candidateId,
      permissions: [...auth.permissions].sort(),
    };
  });
}
