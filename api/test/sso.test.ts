import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearSsoCaches } from '../src/sso.js';
import { approvedCandidate, call, createOrg, PASSWORD, type TestOrg, uniq, useHarness } from './helpers.js';

const h = useHarness();

/** A stand in identity provider: discovery, keys, and a token endpoint that vouches for whoever the test says. */
class FakeProvider {
  server!: Server;
  issuer = '';
  who: { email: string; email_verified?: boolean; name?: string } = { email: '' };
  codes = new Map<string, { nonce: string; challenge: string }>();
  lastTokenRequest: URLSearchParams | null = null;
  private key!: CryptoKey;
  private jwk!: object;

  async start() {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    this.key = privateKey as CryptoKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url!, this.issuer);
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({ issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks` });
      }
      if (url.pathname === '/jwks') return json({ keys: [this.jwk] });
      if (url.pathname === '/token') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const form = new URLSearchParams(raw);
        this.lastTokenRequest = form;
        const entry = this.codes.get(form.get('code') ?? '');
        if (!entry) return json({ error: 'invalid_grant' }, 400);
        const idToken = await new SignJWT({ ...this.who, nonce: entry.nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(this.issuer)
          .setAudience('examguard-client')
          .setSubject('user-1')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(this.key);
        return json({ access_token: 'x', token_type: 'Bearer', id_token: idToken });
      }
      json({ error: 'not_found' }, 404);
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

const idp = new FakeProvider();
beforeAll(async () => {
  await idp.start();
  clearSsoCaches();
});
afterAll(() => idp.server.close());

async function addProvider(org: TestOrg, extra: object = {}) {
  const res = await call(h, 'POST', `/organisations/${org.id}/identity-providers`, org.owner, {
    name: 'University sign in',
    issuer: idp.issuer,
    clientId: 'examguard-client',
    clientSecret: 'shh-secret',
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Runs the whole browser round trip and returns where the app is finally sent. */
async function signIn(providerId: string, app: 'candidate' | 'portal', who: FakeProvider['who']) {
  idp.who = who;
  const start = await h.app.inject({ method: 'GET', url: `/auth/sso/start?provider=${providerId}&app=${app}` });
  expect(start.statusCode).toBe(302);
  const to = new URL(start.headers.location as string);
  expect(to.origin + to.pathname).toBe(`${idp.issuer}/authorize`);
  expect(to.searchParams.get('code_challenge_method')).toBe('S256');
  const code = uniq('code');
  idp.codes.set(code, { nonce: to.searchParams.get('nonce')!, challenge: to.searchParams.get('code_challenge')! });
  const back = await h.app.inject({ method: 'GET', url: `/auth/sso/callback?code=${code}&state=${to.searchParams.get('state')}` });
  expect(back.statusCode).toBe(302);
  return new URL(back.headers.location as string);
}

describe('single sign on', () => {
  it('signs an invited candidate in through their organisation, proving their email', async () => {
    const org = await createOrg(h);
    const providerId = await addProvider(org);
    const email = `${uniq('sso')}@${org.slug}.example`;
    const invited = await call(h, 'POST', '/candidates/invite', org.owner, { email, fullName: 'Sipho SSO' });

    const landed = await signIn(providerId, 'candidate', { email: email.toUpperCase(), email_verified: true, name: 'Sipho SSO' });
    expect(landed.origin).toBe(h.config.publicBaseUrl);
    const handover = landed.searchParams.get('sso')!;
    expect(handover).toBeTruthy();
    // The code verifier and the secret went to the provider.
    expect(idp.lastTokenRequest?.get('code_verifier')).toBeTruthy();
    expect(idp.lastTokenRequest?.get('client_secret')).toBe('shh-secret');

    const tokens = await call(h, 'POST', '/auth/sso/complete', null, { code: handover });
    expect(tokens.status).toBe(200);
    expect((await call(h, 'POST', '/auth/sso/complete', null, { code: handover })).status).toBe(401);
    const { rows } = await h.db.query('SELECT status, identity_status FROM candidates WHERE id = $1', [invited.body.id]);
    expect(rows[0]).toEqual({ status: 'pending_approval', identity_status: 'verified' });
    expect((await call(h, 'GET', '/me/entitlements', tokens.body.accessToken)).status).toBe(200);
  });

  it('turns away people it does not know, and addresses the provider has not verified', async () => {
    const org = await createOrg(h);
    const providerId = await addProvider(org);
    const nobody = await signIn(providerId, 'candidate', { email: `nobody@${org.slug}.example` });
    expect(nobody.searchParams.get('sso_error')).toMatch(/no candidate account/);
    const unverified = await signIn(providerId, 'candidate', { email: `x@${org.slug}.example`, email_verified: false });
    expect(unverified.searchParams.get('sso_error')).toMatch(/did not confirm an email/);
    // A candidate is not staff.
    const name = uniq('cand');
    await approvedCandidate(h, org, name);
    const asStaff = await signIn(providerId, 'portal', { email: `${name}@${org.slug}.example` });
    expect(asStaff.searchParams.get('sso_error')).toMatch(/no staff account/);
  });

  it('registers new candidates for approval when the organisation allows it', async () => {
    const org = await createOrg(h);
    const providerId = await addProvider(org, { createCandidates: true });
    const email = `${uniq('new')}@${org.slug}.example`;
    const landed = await signIn(providerId, 'candidate', { email, name: 'New Person' });
    expect(landed.searchParams.get('sso')).toBeTruthy();
    const { rows } = await h.db.query('SELECT full_name, status, identity_status FROM candidates WHERE organisation_id = $1 AND email = $2', [org.id, email]);
    expect(rows[0]).toEqual({ full_name: 'New Person', status: 'pending_approval', identity_status: 'verified' });
  });

  it('signs staff in, and a trusted provider stands in for two factor sign in', async () => {
    const org = await createOrg(h);
    const providerId = await addProvider(org);
    const email = `${uniq('admin')}@${org.slug}.example`;
    await call(h, 'POST', `/organisations/${org.id}/users`, org.owner, { email, displayName: 'Admin', role: 'admin', password: PASSWORD });
    await h.db.query('UPDATE organisations SET require_staff_mfa = true WHERE id = $1', [org.id]);

    const landed = await signIn(providerId, 'portal', { email });
    expect(landed.origin).toBe(h.config.portalBaseUrl);
    const tokens = (await call(h, 'POST', '/auth/sso/complete', null, { code: landed.searchParams.get('sso') })).body;
    const me = await call(h, 'GET', '/me', tokens.accessToken);
    expect(me.body.mfaSetupRequired).toBe(false);
    expect(me.body.permissions).toContain('candidate:view');
    // The same holds after a refresh.
    const refreshed = await call(h, 'POST', '/auth/refresh', null, { refreshToken: tokens.refreshToken });
    expect((await call(h, 'GET', '/me', refreshed.body.accessToken)).body.mfaSetupRequired).toBe(false);

    // Not trusted: the organisation's own two factor rule applies.
    // (The owner has no two factor sign in either, so the setting is changed directly.)
    await h.db.query('UPDATE identity_providers SET trust_mfa = false WHERE id = $1', [providerId]);
    const again = await signIn(providerId, 'portal', { email });
    const t2 = (await call(h, 'POST', '/auth/sso/complete', null, { code: again.searchParams.get('sso') })).body;
    expect((await call(h, 'GET', '/me', t2.accessToken)).body.mfaSetupRequired).toBe(true);
  });

  it('keeps the secret out of reach, rejects replayed or forged returns, and lists providers publicly', async () => {
    const org = await createOrg(h);
    const providerId = await addProvider(org);
    const list = await call(h, 'GET', `/organisations/${org.id}/identity-providers`, org.owner);
    expect(list.body.callbackUrl).toBe(h.config.ssoCallbackUrl);
    expect(JSON.stringify(list.body)).not.toContain('shh-secret');
    expect(list.body.items[0]).toMatchObject({ hasSecret: true, enabled: true });
    const { rows } = await h.db.query('SELECT client_secret_sealed FROM identity_providers WHERE id = $1', [providerId]);
    expect(rows[0].client_secret_sealed).not.toContain('shh-secret');

    const forged = await h.app.inject({ method: 'GET', url: `/auth/sso/callback?code=abc&state=${'x'.repeat(40)}` });
    expect(new URL(forged.headers.location as string).searchParams.get('sso_error')).toMatch(/took too long or was already used/);

    const pub = await call(h, 'GET', `/public/organisations/${org.slug}/branding`, null);
    expect(pub.body.sso).toEqual([{ id: providerId, name: 'University sign in', forStaff: true, forCandidates: true }]);
    await call(h, 'PATCH', `/organisations/${org.id}/identity-providers/${providerId}`, org.owner, { trustMfa: false });
    await call(h, 'PATCH', `/organisations/${org.id}/identity-providers/${providerId}`, org.owner, { enabled: false });
    expect((await call(h, 'GET', `/public/organisations/${org.slug}/branding`, null)).body.sso).toEqual([]);
    // Changing one setting leaves the others as they were.
    const { rows: kept } = await h.db.query('SELECT trust_mfa, for_staff, enabled FROM identity_providers WHERE id = $1', [providerId]);
    expect(kept[0]).toEqual({ trust_mfa: false, for_staff: true, enabled: false });
    const off = await h.app.inject({ method: 'GET', url: `/auth/sso/start?provider=${providerId}&app=candidate` });
    expect(new URL(off.headers.location as string).searchParams.get('sso_error')).toMatch(/not available/);

    const bad = await call(h, 'POST', `/organisations/${org.id}/identity-providers`, org.owner, { name: 'Broken', issuer: 'http://127.0.0.1:9', clientId: 'x' });
    expect(bad.status).toBe(400);
  });
});
