import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyManifest } from '../src/signing.js';
import type { ReadinessReportInput } from '../src/readiness.js';
import { approvedCandidate, call, createOrg, login, publishedExam, session, type TestOrg, uniq, useHarness } from './helpers.js';

const h = useHarness();

const goodReport = (overrides: Partial<ReadinessReportInput> = {}): ReadinessReportInput => ({
  appVersion: '1.0.0',
  os: { platform: 'windows', version: '11' },
  camera: { detected: true },
  microphone: { detected: true },
  screenCapture: { ready: true },
  storage: { freeMb: 10_000 },
  displays: { count: 1 },
  virtualMachine: { detected: false },
  network: { tested: true, latencyMs: 40 },
  clientTime: new Date().toISOString(),
  ...overrides,
});

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/** Approved candidate assigned to a session; returns their token and entitlement id. */
async function assignedCandidate(org: TestOrg, times?: { startsAt: string; endsAt: string }, extraConfig: object = {}) {
  const { versionId } = await publishedExam(h, org, 10, extraConfig);
  const sessionId = await session(h, org, versionId, times);
  const name = uniq('sarah');
  const candidateId = await approvedCandidate(h, org, name);
  await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [candidateId] });
  const { accessToken } = await login(h, org.slug, `${name}@${org.slug}.example`);
  const list = await call(h, 'GET', '/me/entitlements', accessToken);
  return { token: accessToken, sessionId, candidateId, entitlementId: list.body.items[0].id as string, list: list.body };
}

describe('candidate entitlements', () => {
  it('lists the candidate’s own entitlements with requirements but no marking settings', async () => {
    const org = await createOrg(h);
    const { list } = await assignedCandidate(org, undefined, { security: { camera: true } });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: 'assigned', examName: 'Mathematics 101', lastCheckPassed: null });
    expect(list.items[0].requirements.security.camera).toBe(true);
    expect(list.items[0].requirements).not.toHaveProperty('results');
  });

  it('is closed to staff tokens and to other candidates', async () => {
    const org = await createOrg(h);
    const a = await assignedCandidate(org);
    const b = await assignedCandidate(org);
    expect((await call(h, 'GET', '/me/entitlements', org.owner)).status).toBe(403);
    expect((await call(h, 'POST', `/me/entitlements/${a.entitlementId}/precheck`, b.token, goodReport())).status).toBe(404);
    expect((await call(h, 'GET', `/me/entitlements/${a.entitlementId}/package`, b.token)).status).toBe(404);
  });
});

describe('device readiness check', () => {
  it('records failures, shows them to the organisation, and passes after a fix', async () => {
    const org = await createOrg(h);
    const c = await assignedCandidate(org, undefined, { security: { camera: true, microphone: true } });

    const failed = await call(h, 'POST', `/me/entitlements/${c.entitlementId}/precheck`, c.token, goodReport({ camera: { detected: false } }));
    expect(failed.body.passed).toBe(false);
    expect(failed.body.status).toBe('assigned');
    expect(failed.body.checks.find((x: { key: string }) => x.key === 'camera')).toMatchObject({ passed: false });

    const readiness = await call(h, 'GET', `/sessions/${c.sessionId}/readiness`, org.owner);
    expect(readiness.body.items[0]).toMatchObject({ candidateId: c.candidateId, lastCheckPassed: false, failedChecks: ['camera'] });

    const passed = await call(h, 'POST', `/me/entitlements/${c.entitlementId}/precheck`, c.token, goodReport());
    expect(passed.body).toMatchObject({ passed: true, status: 'precheck_complete' });

    const again = await call(h, 'GET', `/sessions/${c.sessionId}/readiness`, org.owner);
    expect(again.body.items[0]).toMatchObject({ lastCheckPassed: true, failedChecks: [] });
  });

  it('rejects a device clock that is too far out', async () => {
    const org = await createOrg(h);
    const c = await assignedCandidate(org);
    const res = await call(h, 'POST', `/me/entitlements/${c.entitlementId}/precheck`, c.token, goodReport({ clientTime: minutesFromNow(30) }));
    expect(res.body.passed).toBe(false);
    expect(res.body.checks.filter((x: { passed: boolean }) => !x.passed).map((x: { key: string }) => x.key)).toEqual(['clock']);
  });

  it('validates the report shape', async () => {
    const org = await createOrg(h);
    const c = await assignedCandidate(org);
    const res = await call(h, 'POST', `/me/entitlements/${c.entitlementId}/precheck`, c.token, { appVersion: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('exam package download', () => {
  it('requires a passed device check', async () => {
    const org = await createOrg(h);
    const c = await assignedCandidate(org, { startsAt: minutesFromNow(5), endsAt: minutesFromNow(120) });
    const res = await call(h, 'GET', `/me/entitlements/${c.entitlementId}/package`, c.token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/device check/);
  });

  it('is not released long before the session starts', async () => {
    const org = await createOrg(h);
    const c = await assignedCandidate(org, { startsAt: minutesFromNow(24 * 60), endsAt: minutesFromNow(25 * 60) });
    await call(h, 'POST', `/me/entitlements/${c.entitlementId}/precheck`, c.token, goodReport());
    const res = await call(h, 'GET', `/me/entitlements/${c.entitlementId}/package`, c.token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/available from/);
  });

  it('returns a verifiable signed package and an entitlement bound to it', async () => {
    const org = await createOrg(h);
    const c = await assignedCandidate(org, { startsAt: minutesFromNow(5), endsAt: minutesFromNow(120) });
    await call(h, 'POST', `/me/entitlements/${c.entitlementId}/precheck`, c.token, goodReport());

    const res = await call(h, 'GET', `/me/entitlements/${c.entitlementId}/package`, c.token);
    expect(res.status).toBe(200);
    const key = createPublicKey((await call(h, 'GET', '/exam-signing-key')).body.publicKeyPem);

    expect(verifyManifest(res.body.exam.manifest, res.body.exam.signature, key)).toBe(true);
    expect(verifyManifest(res.body.entitlement.payload, res.body.entitlement.signature, key)).toBe(true);
    expect(res.body.entitlement.payload).toMatchObject({
      candidateId: c.candidateId,
      assignmentId: c.entitlementId,
      manifestSha256: res.body.exam.manifestSha256,
    });
    expect(JSON.stringify(res.body.exam.manifest)).not.toMatch(/isCorrect/);
  });

  it('is withdrawn when the candidate is blocked', async () => {
    const org = await createOrg(h);
    const c = await assignedCandidate(org, { startsAt: minutesFromNow(5), endsAt: minutesFromNow(120) });
    await call(h, 'POST', `/me/entitlements/${c.entitlementId}/precheck`, c.token, goodReport());
    await call(h, 'POST', `/candidates/${c.candidateId}/block`, org.owner, {});
    expect((await call(h, 'GET', `/me/entitlements/${c.entitlementId}/package`, c.token)).status).toBe(401);
  });
});
