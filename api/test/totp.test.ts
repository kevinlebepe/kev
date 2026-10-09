import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, newRecoveryCodes, openSecret, otpauthUrl, sealSecret, totpAt, verifyTotp } from '../src/auth/totp.js';

// The RFC 6238 test key "12345678901234567890", SHA-1, with 8 digit codes.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('two factor codes', () => {
  it('matches the RFC 6238 test values', () => {
    expect(totpAt(RFC_SECRET, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(totpAt(RFC_SECRET, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(totpAt(RFC_SECRET, Math.floor(1234567890 / 30), 8)).toBe('89005924');
    expect(totpAt(RFC_SECRET, Math.floor(2000000000 / 30), 8)).toBe('69279037');
  });

  it('round trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 255, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('accepts the code one step either side, and never the same step twice', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now })).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), { nowMs: now })).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now, lastStep: step })).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', { nowMs: now })).toBeNull();
  });

  it('stores secrets encrypted, and detects tampering', () => {
    const server = new TextEncoder().encode('server secret 0123456789 0123456789');
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', server);
    expect(sealed).not.toContain('JBSWY3DP');
    expect(openSecret(sealed, server)).toBe('JBSWY3DPEHPK3PXP');
    // Flip one bit of the encrypted bytes (changing base64 text alone can land in unused padding bits).
    const parts = sealed.split('.');
    const data = Buffer.from(parts[2]!, 'base64url');
    data[0] = data[0]! ^ 1;
    parts[2] = data.toString('base64url');
    expect(() => openSecret(parts.join('.'), server)).toThrow();
    expect(() => openSecret(sealed, new TextEncoder().encode('another secret'))).toThrow();
  });

  it('makes an authenticator link and distinct recovery codes', () => {
    expect(otpauthUrl('ABC', 'a@b.c')).toBe('otpauth://totp/ExamGuard%3Aa%40b.c?secret=ABC&issuer=ExamGuard&algorithm=SHA1&digits=6&period=30');
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((c) => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c))).toBe(true);
  });
});
