import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// Time based one time passwords (RFC 6238), as used by authenticator apps:
// HMAC SHA-1, 30 second steps, 6 digits.

const STEP_SECONDS = 30;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one time step. */
export function totpAt(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const bin = ((mac[offset]! & 127) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/**
 * Checks a code against the current step and one either side, to allow for
 * clock drift. Returns the matching step, which the caller stores so the same
 * code cannot be used twice, or null.
 */
export function verifyTotp(secret: string, code: string, opts: { nowMs?: number; lastStep?: number | null } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(opts.nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (opts.lastStep !== undefined && opts.lastStep !== null && step <= opts.lastStep) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'ExamGuard'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

/** Secrets are stored encrypted with a key derived from the server secret. */
function key(serverSecret: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', serverSecret, Buffer.alloc(0), 'examguard totp secret', 32));
}

export function sealSecret(secret: string, serverSecret: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(serverSecret), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${data.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function openSecret(sealed: string, serverSecret: Uint8Array): string {
  const [version, iv, data, tag] = sealed.split('.');
  if (version !== 'v1' || !iv || !data || !tag) throw new Error('Unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(serverSecret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/** Ten single use recovery codes, for when the phone is lost. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const raw = base32Encode(randomBytes(6)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
