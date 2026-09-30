import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson as serverCanonical, signManifest } from '../../api/src/signing';
import { canonicalJson, verifyPackage } from '../src/lib/verify';

// The client must canonicalise exactly like the server, or valid packages
// would fail verification on candidate devices.
describe('package verification', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const manifest = {
    name: 'Mathematics 101 “Paper 1”',
    version: 1,
    config: { timing: { durationMinutes: 90 }, security: { camera: true } },
    questions: [{ id: 'q1', prompt: 'Ünïcode ✓ 2 + 2?', points: 1.5, options: [{ label: '4', id: 'o1' }] }],
  };

  function pkg() {
    const signedManifest = signManifest(manifest, privateKey);
    const entitlementPayload = { assignmentId: 'a1', manifestSha256: signedManifest.sha256 };
    return {
      exam: { manifest, manifestSha256: signedManifest.sha256, signature: signedManifest.signature },
      entitlement: { payload: entitlementPayload, signature: signManifest(entitlementPayload, privateKey).signature },
    };
  }

  it('canonicalises identically to the server', () => {
    expect(canonicalJson(manifest)).toBe(serverCanonical(manifest));
  });

  it('accepts an intact package', async () => {
    expect((await verifyPackage(pem, pkg())).ok).toBe(true);
  });

  it('rejects a tampered manifest', async () => {
    const p = pkg();
    const tampered = { ...p, exam: { ...p.exam, manifest: { ...manifest, name: 'Other' } } };
    const result = await verifyPackage(pem, tampered);
    expect(result).toMatchObject({ ok: false, manifestSignature: false, manifestHash: false });
  });

  it('rejects an entitlement for a different manifest', async () => {
    const p = pkg();
    const other = { assignmentId: 'a1', manifestSha256: 'f'.repeat(64) };
    const swapped = { ...p, entitlement: { payload: other, signature: signManifest(other, privateKey).signature } };
    const result = await verifyPackage(pem, swapped);
    expect(result).toMatchObject({ ok: false, entitlementSignature: true, entitlementBinding: false });
  });
});
