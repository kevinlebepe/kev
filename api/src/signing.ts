import { createHash, sign, verify, type KeyObject } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace. The
 * candidate app must canonicalise the same way before verifying a manifest.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export interface SignedManifest {
  sha256: string;
  /** Base64 Ed25519 signature over the canonical JSON bytes. */
  signature: string;
}

export function signManifest(manifest: unknown, privateKey: KeyObject): SignedManifest {
  const bytes = Buffer.from(canonicalJson(manifest));
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: sign(null, bytes, privateKey).toString('base64'),
  };
}

export function verifyManifest(manifest: unknown, signature: string, publicKey: KeyObject): boolean {
  return verify(null, Buffer.from(canonicalJson(manifest)), publicKey, Buffer.from(signature, 'base64'));
}
