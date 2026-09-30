import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { type Tx, withTransaction } from '../db.js';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { authorize, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { openSecret, sealSecret } from '../auth/totp.js';
import { discover, pkceChallenge, randomToken, redeemCode, sha256, verifiedEmail } from '../sso.js';
import { idParams, parse } from '../validation.js';
import { issueTokens } from './auth.js';

// Single sign on with OpenID Connect (spec sections 3 and 16). The browser
// leaves for the organisation's provider, comes back to /auth/sso/callback,
// and is handed to the app with a one time code the app swaps for tokens,
// so tokens never appear in an address.

/** How long someone has to sign in at the provider. */
const LOGIN_MINUTES = 10;
/** How long the app has to swap the hand over code for tokens. */
const HANDOVER_SECONDS = 120;

const providerBody = z.object({
  name: z.string().trim().min(1).max(100),
  issuer: z.url().max(500),
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().min(1).max(2000).optional(),
  scopes: z.string().trim().max(500).optional(),
  forStaff: z.boolean().default(true),
  forCandidates: z.boolean().default(true),
  createCandidates: z.boolean().default(false),
  trustMfa: z.boolean().default(true),
});
// No defaults here: a field left out of an update keeps its value.
const providerUpdate = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  issuer: z.url().max(500).optional(),
  clientId: z.string().trim().min(1).max(500).optional(),
  clientSecret: z.string().min(1).max(2000).optional(),
  scopes: z.string().trim().max(500).optional(),
  forStaff: z.boolean().optional(),
  forCandidates: z.boolean().optional(),
  createCandidates: z.boolean().optional(),
  trustMfa: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
const providerParams = z.object({ id: z.uuid(), providerId: z.uuid() });
const startQuery = z.object({ provider: z.uuid(), app: z.enum(['candidate', 'portal']).default('candidate') });
const callbackQuery = z.object({
  state: z.string().min(10).max(200),
  code: z.string().max(4000).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});
const completeBody = z.object({ code: z.string().min(10).max(200) });

export async function ssoRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;
  const allowPrivate = config.allowPrivateWebhooks;
  const callbackUrl = config.ssoCallbackUrl;
  const appUrl = (which: 'candidate' | 'portal') => (which === 'portal' ? config.portalBaseUrl : config.publicBaseUrl);

  // ---- Setting providers up (the owner, who manages security) ----

  app.get('/organisations/:id/identity-providers', { preHandler: authorize('organisation:manage_security') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    if (id !== auth.organisationId) throw notFound('Organisation');
    const { rows } = await db.query(
      `SELECT id, name, issuer, client_id AS "clientId", client_secret_sealed IS NOT NULL AS "hasSecret", scopes,
              for_staff AS "forStaff", for_candidates AS "forCandidates", create_candidates AS "createCandidates",
              trust_mfa AS "trustMfa", enabled, created_at AS "createdAt"
         FROM identity_providers WHERE organisation_id = $1 ORDER BY created_at`,
      [id],
    );
    return { callbackUrl, items: rows };
  });

  app.post('/organisations/:id/identity-providers', { preHandler: authorize('organisation:manage_security') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    if (id !== auth.organisationId) throw notFound('Organisation');
    const body = parse(providerBody, req.body);
    // Reading the provider's settings now catches a wrong address at once, not on exam day.
    try {
      await discover(body.issuer, { allowPrivate });
    } catch (err) {
      throw badRequest(`The identity provider could not be reached: ${(err as Error).message}`);
    }
    const created = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO identity_providers (organisation_id, name, issuer, client_id, client_secret_sealed, scopes, for_staff, for_candidates, create_candidates, trust_mfa)
         VALUES ($1, $2, $3, $4, $5, coalesce($6, 'openid email profile'), $7, $8, $9, $10) RETURNING id`,
        [
          id,
          body.name,
          body.issuer.replace(/\/$/, ''),
          body.clientId,
          body.clientSecret ? sealSecret(body.clientSecret, config.jwtSecret) : null,
          body.scopes ?? null,
          body.forStaff,
          body.forCandidates,
          body.createCandidates,
          body.trustMfa,
        ],
      );
      await audit(tx, { ...auditFrom(req), action: 'sso.provider_add', targetType: 'identity_provider', targetId: rows[0]!.id, data: { name: body.name, issuer: body.issuer } });
      return { id: rows[0]!.id, callbackUrl };
    });
    return reply.code(201).send(created);
  });

  app.patch('/organisations/:id/identity-providers/:providerId', { preHandler: authorize('organisation:manage_security') }, async (req) => {
    const auth = requireOrg(req);
    const { id, providerId } = parse(providerParams, req.params);
    if (id !== auth.organisationId) throw notFound('Organisation');
    const b = parse(providerUpdate, req.body);
    if (b.issuer) {
      try {
        await discover(b.issuer, { allowPrivate });
      } catch (err) {
        throw badRequest(`The identity provider could not be reached: ${(err as Error).message}`);
      }
    }
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE identity_providers SET
            name = coalesce($3, name), issuer = coalesce($4, issuer), client_id = coalesce($5, client_id),
            client_secret_sealed = coalesce($6, client_secret_sealed), scopes = coalesce($7, scopes),
            for_staff = coalesce($8, for_staff), for_candidates = coalesce($9, for_candidates),
            create_candidates = coalesce($10, create_candidates), trust_mfa = coalesce($11, trust_mfa), enabled = coalesce($12, enabled)
          WHERE id = $1 AND organisation_id = $2`,
        [
          providerId,
          id,
          b.name ?? null,
          b.issuer?.replace(/\/$/, '') ?? null,
          b.clientId ?? null,
          b.clientSecret ? sealSecret(b.clientSecret, config.jwtSecret) : null,
          b.scopes ?? null,
          b.forStaff ?? null,
          b.forCandidates ?? null,
          b.createCandidates ?? null,
          b.trustMfa ?? null,
          b.enabled ?? null,
        ],
      );
      if (!rowCount) throw notFound('Identity provider');
      const { clientSecret: _secret, ...logged } = b;
      await audit(tx, { ...auditFrom(req), action: 'sso.provider_update', targetType: 'identity_provider', targetId: providerId, data: { ...logged, secretChanged: Boolean(b.clientSecret) } });
      return { updated: true };
    });
  });

  app.delete('/organisations/:id/identity-providers/:providerId', { preHandler: authorize('organisation:manage_security') }, async (req) => {
    const auth = requireOrg(req);
    const { id, providerId } = parse(providerParams, req.params);
    if (id !== auth.organisationId) throw notFound('Organisation');
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query('DELETE FROM identity_providers WHERE id = $1 AND organisation_id = $2', [providerId, id]);
      if (!rowCount) throw notFound('Identity provider');
      await audit(tx, { ...auditFrom(req), action: 'sso.provider_remove', targetType: 'identity_provider', targetId: providerId });
      return { deleted: true };
    });
  });

  // ---- Signing in ----

  const bounce = (reply: FastifyReply, which: 'candidate' | 'portal', params: Record<string, string>) =>
    reply.redirect(`${appUrl(which)}/?${new URLSearchParams(params).toString()}`, 302);

  // Starts a sign in: remembers what to check on the way back, then sends the browser to the provider.
  app.get('/auth/sso/start', { config: { rateLimit: { max: config.authRateLimitPerMinute, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = parse(startQuery, req.query);
    const { rows } = await db.query<{ id: string; issuer: string; client_id: string; scopes: string; for_staff: boolean; for_candidates: boolean }>(
      `SELECT id, issuer, client_id, scopes, for_staff, for_candidates FROM identity_providers WHERE id = $1 AND enabled`,
      [q.provider],
    );
    const p = rows[0];
    if (!p || (q.app === 'portal' ? !p.for_staff : !p.for_candidates)) return bounce(reply, q.app, { sso_error: 'That sign in option is not available.' });
    let d;
    try {
      d = await discover(p.issuer, { allowPrivate });
    } catch {
      return bounce(reply, q.app, { sso_error: 'Your organisation’s sign in service cannot be reached. Try again, or sign in with your password.' });
    }
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    await db.query(
      `INSERT INTO sso_logins (state_hash, provider_id, app, nonce, code_verifier, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
      [sha256(state), p.id, q.app, nonce, verifier, LOGIN_MINUTES],
    );
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: p.client_id,
      redirect_uri: callbackUrl,
      scope: p.scopes,
      state,
      nonce,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return reply.redirect(url.toString(), 302);
  });

  // The provider sends the browser back here.
  app.get('/auth/sso/callback', { config: { rateLimit: { max: config.authRateLimitPerMinute, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = parse(callbackQuery, req.query);
    // The state is used once, whatever happens next.
    const { rows } = await db.query<{
      id: string;
      app: 'candidate' | 'portal';
      nonce: string;
      code_verifier: string;
      provider_id: string;
      organisation_id: string;
      issuer: string;
      client_id: string;
      client_secret_sealed: string | null;
      for_staff: boolean;
      for_candidates: boolean;
      create_candidates: boolean;
      trust_mfa: boolean;
    }>(
      `DELETE FROM sso_logins l USING identity_providers p
        WHERE l.state_hash = $1 AND l.handover_hash IS NULL AND l.expires_at > now() AND p.id = l.provider_id AND p.enabled
        RETURNING l.id, l.app, l.nonce, l.code_verifier, p.id AS provider_id, p.organisation_id, p.issuer, p.client_id,
                  p.client_secret_sealed, p.for_staff, p.for_candidates, p.create_candidates, p.trust_mfa`,
      [sha256(q.state)],
    );
    const login = rows[0];
    if (!login) return bounce(reply, 'candidate', { sso_error: 'The sign in took too long or was already used. Start again.' });
    if (q.error || !q.code) return bounce(reply, login.app, { sso_error: q.error_description ?? 'The sign in was cancelled.' });

    let email: string | null;
    let name: string | null;
    try {
      const d = await discover(login.issuer, { allowPrivate });
      const claims = await redeemCode(d, {
        clientId: login.client_id,
        clientSecret: login.client_secret_sealed ? openSecret(login.client_secret_sealed, config.jwtSecret) : null,
        code: q.code,
        codeVerifier: login.code_verifier,
        redirectUri: callbackUrl,
        nonce: login.nonce,
      });
      email = verifiedEmail(claims);
      name = typeof claims.name === 'string' ? claims.name.slice(0, 200) : null;
    } catch (err) {
      req.log.warn({ err }, 'single sign on failed');
      return bounce(reply, login.app, { sso_error: 'Your organisation’s sign in could not be completed. Try again, or sign in with your password.' });
    }
    if (!email) return bounce(reply, login.app, { sso_error: 'Your organisation’s sign in did not confirm an email address.' });

    const outcome = await withTransaction(db, (tx) => resolveUser(tx, login, email!, name, req.ip));
    if ('error' in outcome) return bounce(reply, login.app, { sso_error: outcome.error });
    const handover = randomToken();
    await db.query(
      `INSERT INTO sso_logins (state_hash, provider_id, app, nonce, code_verifier, expires_at, handover_hash, user_id, mfa_by_provider)
       VALUES ($1, $2, $3, '', '', now() + make_interval(secs => $4), $5, $6, $7)`,
      [sha256(randomToken()), login.provider_id, login.app, HANDOVER_SECONDS, sha256(handover), outcome.userId, login.trust_mfa && login.app === 'portal'],
    );
    return bounce(reply, login.app, { sso: handover });
  });

  /** Finds, or where allowed creates, the account the provider vouched for. */
  async function resolveUser(
    tx: Tx,
    login: { app: 'candidate' | 'portal'; organisation_id: string; provider_id: string; for_staff: boolean; for_candidates: boolean; create_candidates: boolean },
    email: string,
    name: string | null,
    ip: string,
  ): Promise<{ userId: string } | { error: string }> {
    const org = login.organisation_id;
    const { rows: users } = await tx.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email]);
    let userId = users[0]?.id ?? null;

    if (login.app === 'portal') {
      if (!login.for_staff || !userId) return { error: `There is no staff account for ${email} here.` };
      const { rowCount } = await tx.query(`SELECT 1 FROM organisation_users WHERE organisation_id = $1 AND user_id = $2 AND status = 'active'`, [org, userId]);
      if (!rowCount) return { error: `There is no staff account for ${email} here.` };
    } else {
      if (!login.for_candidates) return { error: 'Candidates cannot sign in this way.' };
      const { rows: cands } = await tx.query<{ id: string; user_id: string | null; status: string }>(
        `SELECT id, user_id, status FROM candidates WHERE organisation_id = $1 AND lower(email) = $2 AND erased_at IS NULL FOR UPDATE`,
        [org, email],
      );
      const c = cands[0];
      if (c && ['rejected', 'blocked'].includes(c.status)) return { error: 'Your account with this organisation is not active. Contact exam support.' };
      if (!c && !login.create_candidates) return { error: `There is no candidate account for ${email} here. Ask your organisation to invite you.` };
      if (!userId) {
        const { rows } = await tx.query<{ id: string }>('INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id', [email, name ?? email]);
        userId = rows[0]!.id;
      }
      if (c) {
        // Signing in through the provider proves the address, as accepting an invitation does.
        await tx.query(
          `UPDATE candidates SET user_id = coalesce(user_id, $2),
                  status = CASE WHEN status IN ('invited', 'registered') THEN 'pending_approval' ELSE status END,
                  identity_status = CASE WHEN identity_status IN ('unverified', 'email_pending') THEN 'verified' ELSE identity_status END,
                  updated_at = now()
            WHERE id = $1`,
          [c.id, userId],
        );
        if (c.user_id) userId = c.user_id;
      } else {
        await tx.query(
          `INSERT INTO candidates (organisation_id, user_id, email, full_name, status, identity_status) VALUES ($1, $2, $3, $4, 'pending_approval', 'verified')`,
          [org, userId, email, name ?? email],
        );
      }
    }
    await audit(tx, { organisationId: org, actorUserId: userId, action: 'auth.sso', targetType: 'identity_provider', targetId: login.provider_id, ip, data: { app: login.app } });
    return { userId: userId! };
  }

  // The app swaps the one time hand over code for tokens.
  app.post('/auth/sso/complete', { config: { rateLimit: { max: config.authRateLimitPerMinute, timeWindow: '1 minute' } } }, async (req) => {
    const { code } = parse(completeBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ user_id: string; organisation_id: string; mfa_by_provider: boolean }>(
        `DELETE FROM sso_logins l USING identity_providers p
          WHERE l.handover_hash = $1 AND l.expires_at > now() AND p.id = l.provider_id
          RETURNING l.user_id, p.organisation_id, l.mfa_by_provider`,
        [sha256(code)],
      );
      const r = rows[0];
      if (!r) throw unauthorized('The sign in took too long. Start again.');
      await tx.query('UPDATE users SET failed_logins = 0 WHERE id = $1', [r.user_id]);
      return issueTokens(tx, deps, r.user_id, r.organisation_id, null, r.mfa_by_provider ? 'sso_mfa' : 'sso');
    });
  });

  // Old unfinished sign ins are cleared as new ones start; nothing else needs them.
  app.addHook('onResponse', async (req) => {
    if (req.routeOptions.url === '/auth/sso/start' && Math.random() < 0.05) {
      await db.query(`DELETE FROM sso_logins WHERE expires_at < now() - interval '1 hour'`).catch(() => undefined);
    }
  });
}
