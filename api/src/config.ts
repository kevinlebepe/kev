import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  const privateKey = persistentDevKey();
  return { privateKey, publicKey: createPublicKey(privateKey), keyId: 'dev-local' };
}

// A key made fresh on every start would make every exam published before a
// restart fail its signature check, which is confusing during development.
// So development keeps one key in a file that is never committed. Production
// refuses to start without a real key from the secret store.
function persistentDevKey(): KeyObject {
  const file = fileURLToPath(new URL('../.dev-signing-key.pem', import.meta.url));
  const read = () => createPrivateKey(readFileSync(file));
  try {
    return read();
  } catch {
    // No key yet: make one.
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  try {
    // 'wx' fails if another process created it first, and then we use theirs.
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  } catch {
    // Someone else won, or the folder is read only.
  }
  try {
    return read();
  } catch {
    return privateKey;
  }
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

/**
 * ICE_SERVERS is a JSON list of RTCIceServer objects. Without it a public
 * STUN server is used, which connects most home and office networks. Strict
 * networks need a TURN server (see docs/IMPLEMENTATION.md).
 */
function parseIceServers(raw: string | undefined): Config['iceServers'] {
  if (!raw) return [{ urls: 'stun:stun.l.google.com:19302' }];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('ICE_SERVERS must be a JSON list');
  return parsed as Config['iceServers'];
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
  /** Address of the staff portal, used in staff invitation and password reset emails. */
  portalBaseUrl: string;
  /** How long before a session starts a candidate may download the exam package. */
  packagePrefetchMinutes: number;
  /** Extra time after the deadline in which a final save or submit is still accepted (network delay). */
  attemptGraceSeconds: number;
  examSigning: { privateKey: KeyObject; publicKey: KeyObject; keyId: string };
  /** SMTP server for outgoing email. Without it, development prints emails to the log and production sends none. */
  smtpUrl: string | null;
  /** STUN and TURN servers for live video, as RTCIceServer objects. */
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  /** Lets webhooks reach private and local addresses. Development only. */
  allowPrivateWebhooks: boolean;
  /** Folder for recordings when no other store is configured. */
  recordingDir: string;
  /** S3 compatible storage for recordings, when S3_BUCKET is set. */
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    pathStyle: boolean;
    serverSideEncryption?: string | undefined;
  } | null;
  mailFrom: string;
}

function loadS3(): Config['s3'] {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return null;
  const region = process.env.S3_REGION ?? 'us-east-1';
  return {
    bucket,
    region,
    endpoint: process.env.S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`,
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    // Path style suits MinIO and most S3 compatible services; Amazon accepts both.
    pathStyle: process.env.S3_PATH_STYLE !== '0',
    serverSideEncryption: process.env.S3_SERVER_SIDE_ENCRYPTION || undefined,
  };
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
    portalBaseUrl: process.env.PORTAL_BASE_URL ?? 'http://localhost:5174',
    packagePrefetchMinutes: Number(process.env.PACKAGE_PREFETCH_MINUTES ?? 10),
    attemptGraceSeconds: Number(process.env.ATTEMPT_GRACE_SECONDS ?? 30),
    examSigning: loadSigningKey(),
    smtpUrl: process.env.SMTP_URL || null,
    recordingDir: process.env.RECORDING_DIR ?? 'recordings',
    s3: loadS3(),
    iceServers: parseIceServers(process.env.ICE_SERVERS),
    allowPrivateWebhooks: !isProduction && process.env.ALLOW_PRIVATE_WEBHOOKS !== '0',
    mailFrom: process.env.MAIL_FROM ?? 'ExamGuard <no-reply@examguard.local>',
    ...overrides,
  };
}
