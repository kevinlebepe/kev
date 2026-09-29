import { describe, expect, it } from 'vitest';
import {
  approvedCandidate,
  call,
  createOrg,
  invigilator,
  login,
  publishedExam,
  session,
  type TestOrg,
  useHarness,
} from './helpers.js';

const h = useHarness();

async function sessionWithCandidates(org: TestOrg, count: number, maxPerInvigilator = 10) {
  const { versionId } = await publishedExam(h, org, maxPerInvigilator);
  const sessionId = await session(h, org, versionId);
  const candidates: string[] = [];
  for (let i = 0; i < count; i++) candidates.push(await approvedCandidate(h, org));
  const assigned = await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: candidates });
  expect(assigned.body.assigned).toHaveLength(count);
  return { sessionId, candidates };
}

async function roster(org: TestOrg, sessionId: string, n: number) {
  const invs = [];
  for (let i = 0; i < n; i++) invs.push(await invigilator(h, org));
  await call(h, 'POST', `/sessions/${sessionId}/invigilators`, org.owner, { invigilatorIds: invs.map((i) => i.id) });
  return invs;
}

describe('invigilator allocation', () => {
  it('only assigns approved candidates to sessions', async () => {
    const org = await createOrg(h);
    const { versionId } = await publishedExam(h, org);
    const sessionId = await session(h, org, versionId);
    const invited = await call(h, 'POST', '/candidates/invite', org.owner, { email: `p@${org.slug}.example`, fullName: 'P' });
    const res = await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [invited.body.id] });
    expect(res.body).toEqual({ assigned: [], rejected: [{ candidateId: invited.body.id, reason: 'candidate_invited' }] });
  });

  // Spec section 22: "An invigilator cannot be assigned an 11th active candidate."
  it('auto-allocation caps each invigilator at 10, queues the rest and alerts the administrator', async () => {
    const org = await createOrg(h);
    const { sessionId } = await sessionWithCandidates(org, 12);
    await roster(org, sessionId, 1);

    const res = await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId });
    expect(res.body.assignments).toHaveLength(10);
    expect(res.body.unassigned).toHaveLength(2);

    const { rows } = await h.db.query(
      `SELECT payload FROM notifications WHERE organisation_id = $1 AND kind = 'invigilator_capacity_alert'`,
      [org.id],
    );
    expect(rows[0].payload).toEqual({ sessionId, unassigned: 2 });

    const status = await call(h, 'GET', `/sessions/${sessionId}/status`, org.owner);
    expect(status.body.invigilation).toMatchObject({ covered: 10, uncovered: 2 });
  });

  it('balances load across invigilators and honours a lower exam cap', async () => {
    const org = await createOrg(h);
    const { sessionId } = await sessionWithCandidates(org, 9, 4);
    await roster(org, sessionId, 2);
    const res = await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId, randomise: true });
    const per = res.body.assignments.reduce(
      (m: Record<string, number>, a: { invigilatorId: string }) => ({ ...m, [a.invigilatorId]: (m[a.invigilatorId] ?? 0) + 1 }),
      {},
    );
    expect(Object.values(per)).toEqual([4, 4]);
    expect(res.body.unassigned).toHaveLength(1);
  });

  it('manual assignment of an 11th candidate is refused', async () => {
    const org = await createOrg(h);
    const { sessionId, candidates } = await sessionWithCandidates(org, 11);
    const [inv] = await roster(org, sessionId, 1);
    for (const candidateId of candidates.slice(0, 10)) {
      const ok = await call(h, 'POST', '/live/assignments', org.owner, { mode: 'manual', sessionId, candidateId, invigilatorId: inv!.id });
      expect(ok.status).toBe(200);
    }
    const eleventh = await call(h, 'POST', '/live/assignments', org.owner, {
      mode: 'manual',
      sessionId,
      candidateId: candidates[10],
      invigilatorId: inv!.id,
    });
    expect(eleventh.status).toBe(409);
  });

  it('the database refuses an 11th assignment even when the API is bypassed', async () => {
    const org = await createOrg(h);
    const { sessionId, candidates } = await sessionWithCandidates(org, 11);
    const [inv] = await roster(org, sessionId, 1);
    const insert = (candidateId: string) =>
      h.db.query(
        `INSERT INTO invigilation_assignments (organisation_id, session_id, invigilator_id, candidate_id) VALUES ($1, $2, $3, $4)`,
        [org.id, sessionId, inv!.id, candidateId],
      );
    for (const c of candidates.slice(0, 10)) await insert(c);
    await expect(insert(candidates[10]!)).rejects.toThrow(/at capacity/);
  });

  it('holds the limit under concurrent manual assignments', async () => {
    const org = await createOrg(h);
    const { sessionId, candidates } = await sessionWithCandidates(org, 15);
    const [inv] = await roster(org, sessionId, 1);
    const results = await Promise.all(
      candidates.map((candidateId) =>
        call(h, 'POST', '/live/assignments', org.owner, { mode: 'manual', sessionId, candidateId, invigilatorId: inv!.id }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });

  it('released assignments free capacity', async () => {
    const org = await createOrg(h);
    const { sessionId } = await sessionWithCandidates(org, 11);
    await roster(org, sessionId, 1);
    const first = await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId });
    expect(first.body.unassigned).toHaveLength(1);
    await call(h, 'POST', `/live/assignments/${first.body.assignments[0].id}/release`, org.owner);
    const second = await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId });
    // The released candidate and the queued one compete for the single free slot.
    expect(second.body.assignments).toHaveLength(1);
    expect(second.body.unassigned).toHaveLength(1);
  });
});

describe('live console scope', () => {
  it('an invigilator sees only their own assigned candidates', async () => {
    const org = await createOrg(h);
    const { sessionId } = await sessionWithCandidates(org, 6);
    const [a, b] = await roster(org, sessionId, 2);
    await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId });

    const tokenA = (await login(h, org.slug, a!.email)).accessToken;
    const view = await call(h, 'GET', `/live/sessions/${sessionId}`, tokenA);
    expect(view.status).toBe(200);
    expect(view.body.load).toEqual({ active: 3, capacity: 10 });
    expect(view.body.status).toBe('monitoring');
    expect(view.body.candidates).toHaveLength(3);

    const { rows } = await h.db.query<{ candidate_id: string }>(
      'SELECT candidate_id FROM invigilation_assignments WHERE invigilator_id = $1 AND active',
      [b!.id],
    );
    const visible = view.body.candidates.map((c: { candidateId: string }) => c.candidateId);
    for (const r of rows) expect(visible).not.toContain(r.candidate_id);

    // Staff without an invigilator record cannot open the console even with live:view.
    expect((await call(h, 'GET', `/live/sessions/${sessionId}`, org.owner)).status).toBe(403);
  });
});
