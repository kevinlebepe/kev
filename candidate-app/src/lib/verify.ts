// Integrity checks the application runs before an exam starts (spec section 6):
// the manifest and entitlement must both carry valid signatures from the
// published key, and the entitlement must name this exact manifest.

/** Must match the server's canonicalisation byte for byte (api/src/signing.ts). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return bytes.buffer;
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function importPublicKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', pemToDer(pem), { name: 'Ed25519' }, false, ['verify']);
}

export async function verifySigned(key: CryptoKey, payload: unknown, signatureB64: string): Promise<boolean> {
  const data = new TextEncoder().encode(canonicalJson(payload));
  return crypto.subtle.verify({ name: 'Ed25519' }, key, b64ToBytes(signatureB64), data);
}

export async function sha256Hex(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(payload)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PackageVerification {
  manifestSignature: boolean;
  manifestHash: boolean;
  entitlementSignature: boolean;
  entitlementBinding: boolean;
  ok: boolean;
}

export async function verifyPackage(
  pem: string,
  pkg: {
    exam: { manifest: unknown; manifestSha256: string; signature: string };
    entitlement: { payload: { manifestSha256: string }; signature: string };
  },
): Promise<PackageVerification> {
  const key = await importPublicKey(pem);
  const manifestSignature = await verifySigned(key, pkg.exam.manifest, pkg.exam.signature);
  const manifestHash = (await sha256Hex(pkg.exam.manifest)) === pkg.exam.manifestSha256;
  const entitlementSignature = await verifySigned(key, pkg.entitlement.payload, pkg.entitlement.signature);
  const entitlementBinding = pkg.entitlement.payload.manifestSha256 === pkg.exam.manifestSha256;
  return {
    manifestSignature,
    manifestHash,
    entitlementSignature,
    entitlementBinding,
    ok: manifestSignature && manifestHash && entitlementSignature && entitlementBinding,
  };
}
