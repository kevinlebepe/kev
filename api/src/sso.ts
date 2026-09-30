import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import { checkWebhookUrl } from './webhooks.js';

// A small OpenID Connect client (authorisation code flow with PKCE), enough
// to sign people in through an organisation's own identity provider. Every
// address the provider hands back is checked like a webhook address, so a
// provider set up by an organisation cannot point the server at its own
// private network.

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const CACHE_MS = 60 * 60_000;

export const b64url = (buf: Buffer) => buf.toString('base64url');
export const randomToken = () => b64url(randomBytes(32));
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** The PKCE challenge for a verifier (S256). */
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

export async function discover(issuer: string, opts: { allowPrivate: boolean; fetch?: typeof fetch }): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.doc;
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  await checkWebhookUrl(url, { allowPrivate: opts.allowPrivate });
  const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!res.ok) throw new Error(`The identity provider's settings could not be read (${res.status})`);
  const doc = (await res.json()) as Partial<Discovery>;
  for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[key] !== 'string') throw new Error(`The identity provider's settings have no ${key}`);
  }
  // The provider must name itself as the issuer it was set up with.
  if (doc.issuer!.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) throw new Error('The identity provider gives a different issuer');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) await checkWebhookUrl(doc[key]!, { allowPrivate: opts.allowPrivate });
  discoveryCache.set(issuer, { at: Date.now(), doc: doc as Discovery });
  return doc as Discovery;
}

/** Exchanges the code from the provider for tokens, and verifies the ID token. */
export async function redeemCode(
  d: Discovery,
  p: { clientId: string; clientSecret: string | null; code: string; codeVerifier: string; redirectUri: string; nonce: string },
  opts: { fetch?: typeof fetch } = {},
): Promise<JWTPayload> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.codeVerifier,
    ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
  });
  const res = await (opts.fetch ?? fetch)(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.id_token) throw new Error(body.error_description ?? body.error ?? `The identity provider refused the sign in (${res.status})`);
  let jwks = jwksCache.get(d.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(d.jwks_uri));
    jwksCache.set(d.jwks_uri, jwks);
  }
  const { payload } = await jwtVerify(body.id_token, jwks, { issuer: d.issuer, audience: p.clientId, clockTolerance: 60 });
  if (payload.nonce !== p.nonce) throw new Error('The sign in did not match the one that was started');
  return payload;
}

/** The email the provider vouches for, or null. A provider that says the address is unverified is not trusted. */
export function verifiedEmail(claims: JWTPayload): string | null {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  if (claims.email_verified === false || claims.email_verified === 'false') return null;
  return email;
}

/** For tests: forget cached provider settings. */
export function clearSsoCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}
