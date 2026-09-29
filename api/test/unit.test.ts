import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { allocate, liveStatus } from '../src/allocation.js';
import { selfRegistrationOutcome, transition } from '../src/candidateStatus.js';
import { canonicalJson, signManifest, verifyManifest } from '../src/signing.js';

describe('allocate', () => {
  const ids = (n: number, p = 'c') => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(3, '0')}`);

  it('never gives an invigilator more than 10', () => {
    const result = allocate(ids(25), [{ id: 'a', load: 0, capacity: 10 }, { id: 'b', load: 0, capacity: 10 }]);
    const counts = result.assignments.reduce<Record<string, number>>((m, a) => ({ ...m, [a.invigilatorId]: (m[a.invigilatorId] ?? 0) + 1 }), {});
    expect(counts).toEqual({ a: 10, b: 10 });
    expect(result.unassigned).toHaveLength(5);
  });

  it('counts existing load and clamps any configured capacity to 10', () => {
    const result = allocate(ids(5), [{ id: 'a', load: 8, capacity: 50 }]);
    expect(result.assignments).toHaveLength(2);
    expect(result.unassigned).toHaveLength(3);
  });

  it('balances toward the least-loaded invigilator', () => {
    const result = allocate(ids(6), [{ id: 'a', load: 4, capacity: 10 }, { id: 'b', load: 0, capacity: 10 }]);
    const toB = result.assignments.filter((a) => a.invigilatorId === 'b').length;
    expect(toB).toBe(5); // b catches up to 4, then they alternate
  });

  it('respects a lower session cap', () => {
    const result = allocate(ids(10), [{ id: 'a', load: 0, capacity: 10 }], { sessionCap: 3 });
    expect(result.assignments).toHaveLength(3);
  });

  it('queues everyone when nobody is available', () => {
    expect(allocate(ids(2), [])).toEqual({ assignments: [], unassigned: ids(2) });
  });

  it('derives live status', () => {
    expect(liveStatus('active', 0, 10)).toBe('available');
    expect(liveStatus('active', 3, 10)).toBe('monitoring');
    expect(liveStatus('active', 10, 10)).toBe('at_capacity');
    expect(liveStatus('paused', 0, 10)).toBe('paused');
  });
});

describe('candidate lifecycle', () => {
  it('only approves verified or manually reviewed candidates awaiting approval', () => {
    expect(transition('approve', { status: 'pending_approval', identityStatus: 'verified' })).toEqual({ ok: true, to: 'approved' });
    expect(transition('approve', { status: 'pending_approval', identityStatus: 'manual_review' }).ok).toBe(true);
    expect(transition('approve', { status: 'registered', identityStatus: 'email_pending' }).ok).toBe(false);
    expect(transition('approve', { status: 'invited', identityStatus: 'unverified' }).ok).toBe(false);
    expect(transition('approve', { status: 'blocked', identityStatus: 'verified' }).ok).toBe(false);
  });

  it('unblocking returns the candidate to review, not approval', () => {
    expect(transition('unblock', { status: 'blocked', identityStatus: 'verified' })).toEqual({ ok: true, to: 'pending_approval' });
  });

  it('routes unapproved email domains to manual review', () => {
    expect(selfRegistrationOutcome('s@students.uni.example', ['uni.example'])).toEqual({
      status: 'registered',
      identityStatus: 'email_pending',
    });
    expect(selfRegistrationOutcome('s@gmail.example', ['uni.example'])).toEqual({
      status: 'pending_approval',
      identityStatus: 'manual_review',
    });
    // A lookalike domain must not match.
    expect(selfRegistrationOutcome('s@evil-uni.example', ['uni.example']).identityStatus).toBe('manual_review');
  });
});

describe('manifest signing', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  it('canonicalises key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it('verifies an untouched manifest and rejects a tampered one', () => {
    const manifest = { examId: 'x', questions: [{ id: 'q1', prompt: 'Hi' }] };
    const { signature } = signManifest(manifest, privateKey);
    expect(verifyManifest({ questions: [{ prompt: 'Hi', id: 'q1' }], examId: 'x' }, signature, publicKey)).toBe(true);
    expect(verifyManifest({ ...manifest, examId: 'y' }, signature, publicKey)).toBe(false);
  });
});
