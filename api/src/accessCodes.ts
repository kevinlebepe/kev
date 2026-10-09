import { createHash, randomInt } from 'node:crypto';

// Exam access codes: 12 characters from an alphabet without look alikes (no
// 0, O, 1, I or L), about 58 bits, shown as three groups of four.

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newAccessCode(): string {
  let raw = '';
  for (let i = 0; i < 12; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** Spaces, dashes and case do not matter when the code is typed back. */
export function hashAccessCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, ''), 'utf8').digest('hex');
}
