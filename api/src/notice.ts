import { createHash } from 'node:crypto';

/** The fingerprint of a candidate notice: what a candidate's agreement is recorded against. */
export function noticeHash(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}
