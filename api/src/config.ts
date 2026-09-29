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

export interface Config {
  databaseUrl: string;
  port: number;
  jwtSecret: Uint8Array;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  invitationTtlHours: number;
  /** Per-IP requests per minute on login/refresh and public onboarding endpoints. */
  authRateLimitPerMinute: number;
  publicBaseUrl: string;
  examSigning: { privateKey: KeyObject; publicKey: KeyObject; keyId: string };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: required('DATABASE_URL', 'postgres://examguard:examguard@localhost:5432/examguard'),
    port: Number(process.env.PORT ?? 3000),
    jwtSecret: new TextEncoder().encode(secret('JWT_SECRET', 'dev-only-jwt-secret-change-me-0123456789')),
    accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 14),
    invitationTtlHours: Number(process.env.INVITATION_TTL_HOURS ?? 24 * 7),
    authRateLimitPerMinute: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? 20),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
    examSigning: loadSigningKey(),
    ...overrides,
  };
}
