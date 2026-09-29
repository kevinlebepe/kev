import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

// Development-only fallbacks keep local setup to a single command. In
// production every secret must come from the managed secret store (spec 19).
function secret(name: string, devFallback: string): string {
  return isProduction ? required(name) : required(name, devFallback);
}

function loadSigningKey(): { privateKey: KeyObject; publicKey: KeyObject; keyId: string } {
  const pem = process.env.EXAM_SIGNING_PRIVATE_KEY;
  if (pem) {
    const privateKey = createPrivateKey(pem);
    return { privateKey, publicKey: createPublicKey(privateKey), keyId: required('EXAM_SIGNING_KEY_ID') };
  }
  if (isProduction) {
    throw new Error('Missing required environment variable EXAM_SIGNING_PRIVATE_KEY');
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, keyId: 'dev-ephemeral' };
}

/**
 * Which proxies may set X-Forwarded-For. Off by default: trusting the header
 * from anyone lets a client rotate it and escape per-IP rate limits. Set
 * TRUST_PROXY to the load balancer's addresses or CIDRs (comma separated)
 * when running behind one.
 */
export type TrustProxy = boolean | string;

function parseTrustProxy(raw: string | undefined): TrustProxy {
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  return raw;
}

export interface Config {
  databaseUrl: string;
  port: number;
  trustProxy: TrustProxy;
  jwtSecret: Uint8Array;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  invitationTtlHours: number;
  /** Per-IP requests per minute on login/refresh and public onboarding endpoints. */
  authRateLimitPerMinute: number;
  publicBaseUrl: string;
  /** How long before a session starts a candidate may download the exam package. */
  packagePrefetchMinutes: number;
  examSigning: { privateKey: KeyObject; publicKey: KeyObject; keyId: string };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: required('DATABASE_URL', 'postgres://examguard:examguard@localhost:5432/examguard'),
    port: Number(process.env.PORT ?? 3000),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    jwtSecret: new TextEncoder().encode(secret('JWT_SECRET', 'dev-only-jwt-secret-change-me-0123456789')),
    accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 14),
    invitationTtlHours: Number(process.env.INVITATION_TTL_HOURS ?? 24 * 7),
    authRateLimitPerMinute: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? 20),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
    packagePrefetchMinutes: Number(process.env.PACKAGE_PREFETCH_MINUTES ?? 10),
    examSigning: loadSigningKey(),
    ...overrides,
  };
}
