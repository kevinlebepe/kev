import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config.js';

export interface AccessClaims {
  sub: string;
  org: string | null;
  /** How the person signed in, when it matters: 'sso_mfa' is single sign on through a provider trusted for two factor sign in. */
  amr?: string | null;
}

const ISSUER = 'examguard';
const AUDIENCE = 'examguard-api';

export async function signAccessToken(config: Config, claims: AccessClaims): Promise<string> {
  return new SignJWT({ org: claims.org, ...(claims.amr ? { amr: claims.amr } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(config.jwtSecret);
}

export async function verifyAccessToken(config: Config, token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, { issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload.sub !== 'string') return null;
    const org = typeof payload.org === 'string' ? payload.org : null;
    return { sub: payload.sub, org, amr: typeof payload.amr === 'string' ? payload.amr : null };
  } catch {
    return null;
  }
}

const MFA_AUDIENCE = 'examguard-mfa';

/** A five minute ticket between the password and the second step. It cannot be used as an access token. */
export async function signMfaToken(config: Config, claims: AccessClaims): Promise<string> {
  return new SignJWT({ org: claims.org })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(MFA_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(config.jwtSecret);
}

export async function verifyMfaToken(config: Config, token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, { issuer: ISSUER, audience: MFA_AUDIENCE });
    if (typeof payload.sub !== 'string') return null;
    return { sub: payload.sub, org: typeof payload.org === 'string' ? payload.org : null };
  } catch {
    return null;
  }
}
