import { SignJWT, jwtVerify } from 'jose';
import type { Config } from '../config.js';

export interface AccessClaims {
  sub: string;
  org: string | null;
}

const ISSUER = 'examguard';
const AUDIENCE = 'examguard-api';

export async function signAccessToken(config: Config, claims: AccessClaims): Promise<string> {
  return new SignJWT({ org: claims.org })
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
    return { sub: payload.sub, org };
  } catch {
    return null;
  }
}
