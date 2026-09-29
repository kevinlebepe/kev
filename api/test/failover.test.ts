import { describe, expect, it } from 'vitest';
import { failoverSession, runFailover } from '../src/failover.js';
import { approvedCandidate, call, createOrg, invigilator, login, minutesFromNow, publishedExam, session, type TestOrg, useHarness } from './helpers.js';

const h = useHarness();

/** An open session with candidates allocated to one invigilator, and a second invigilator on the roster. */
async function setup(org: TestOrg, candidates: number, maxPerInvigilator = 10) {
  const { versionId } = await publishedExam(h, org, maxPerInvigilator);
  const sessionId = await session(h, org, versionId, { startsAt: minutesFromNow(-30), endsAt: minutesFromNow(120) });
  const ids: string[] = [];
  for (let i = 0; i < candidates; i++) ids.push(await approvedCandidate(h, org));
  await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: ids });
  await call(h, 'PATCH', `/sessions/${sessionId}`, org.owner, { status: 'open' });
  const first = await invigilator(h, org);
  await call(h, 'POST', `/sessions/${sessionId}/invigilators`, org.owner, { invigilatorIds: [first.id] });
  await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId });
  const second = await invigilator(h, org);
  await call(h, 'POST', `/sessions/${sessionId}/invigilators`, org.owner, { invigilatorIds: [second.id] });
  const token = async (inv: { email: string }) => (await login(h, org.slug, inv.email)).accessToken;
  return { sessionId, ids, first, second, token };
}

const watching = async (invigilatorId: string) =>
  (await h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM invigilation_assignments WHERE invigilator_id = $1 AND active', [invigilatorId])).rows[0]!.n;

describe('invigilator failover', () => {
  it('leaves candidates alone while their invigilator has the console open', async () => {
    const org = await createOrg(h);
    const s = await setup(org, 3);
    await call(h, 'GET', `/live/sessions/${s.sessionId}`, await s.token(s.first));
    await call(h, 'GET', `/live/sessions/${s.sessionId}`, await s.token(s.second));
    expect((await failoverSession(h.db, s.sessionId)).moved).toEqual([]);
    expect(await watching(s.first.id)).toBe(3);
  });

  it('moves candidates from an invigilator who has gone to one who is present', async () => {
    const org = await createOrg(h);
    const s = await setup(org, 3);
    await call(h, 'GET', `/live/sessions/${s.sessionId}`, await s.token(s.first));
    await call(h, 'GET', `/live/sessions/${s.sessionId}`, await s.token(s.second));
    await h.db.query(`UPDATE invigilators SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [s.first.id]);

    const result = await failoverSession(h.db, s.sessionId);
    expect(result.moved).toHaveLength(3);
    expect(result.moved.every((m) => m.from === s.first.id && m.to === s.second.id)).toBe(true);
    expect(await watching(s.first.id)).toBe(0);
    expect(await watching(s.second.id)).toBe(3);
    const view = await call(h, 'GET', `/live/sessions/${s.sessionId}`, await s.token(s.second));
    expect(view.body.candidates).toHaveLength(3);
    const { rows } = await h.db.query(`SELECT action FROM audit_logs WHERE target_id = $1 AND action = 'invigilation.failover'`, [s.sessionId]);
    expect(rows).toHaveLength(1);
  });

  it('moves candidates from a paused invigilator, and treats one who never opened the console as gone', async () => {
    const org = await createOrg(h);
    const s = await setup(org, 2);
    await call(h, 'GET', `/live/sessions/${s.sessionId}`, await s.token(s.second));
    // The first invigilator never opened the console, and the session started 30 minutes ago.
    expect((await failoverSession(h.db, s.sessionId)).moved).toHaveLength(2);

    await call(h, 'GET', `/live/sessions/${s.sessionId}`, await s.token(s.first));
    await call(h, 'PATCH', `/invigilators/${s.second.id}`, org.owner, { status: 'paused' });
    const back = await failoverSession(h.db, s.sessionId);
    expect(back.moved.map((m) => m.to)).toEqual([s.first.id, s.first.id]);
  });

  it('keeps candidates where they are when nobody present has room', async () => {
    const org = await createOrg(h);
    const s = await setup(org, 3, 2);
    // The per session limit is 2: the first invigilator has 2, and 1 is unassigned.
    expect(await watching(s.first.id)).toBe(2);
    await call(h, 'GET', `/live/sessions/${s.sessionId}`, await s.token(s.second));
    await h.db.query(`UPDATE invigilation_assignments SET active = false, released_at = now() WHERE session_id = $1`, [s.sessionId]);
    await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId: s.sessionId });
    // Now each has 2... the second is present, the first has gone.
    await call(h, 'GET', `/live/sessions/${s.sessionId}`, await s.token(s.first));
    await h.db.query(`UPDATE invigilators SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [s.first.id]);
    const before = await watching(s.first.id);
    const result = await failoverSession(h.db, s.sessionId);
    const secondHas = await watching(s.second.id);
    expect(secondHas).toBeLessThanOrEqual(2);
    expect(result.moved.length + result.stranded.length).toBe(before);
    expect(await watching(s.first.id)).toBe(result.stranded.length);
  });

  it('does nothing for sessions that are not open, and the sweep finds sessions that need it', async () => {
    const org = await createOrg(h);
    const s = await setup(org, 1);
    await call(h, 'GET', `/live/sessions/${s.sessionId}`, await s.token(s.second));
    await h.db.query(`UPDATE invigilators SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [s.first.id]);
    await call(h, 'PATCH', `/sessions/${s.sessionId}`, org.owner, { status: 'closed' });
    expect((await failoverSession(h.db, s.sessionId)).moved).toEqual([]);

    const other = await setup(await createOrg(h), 1);
    await call(h, 'GET', `/live/sessions/${other.sessionId}`, await other.token(other.second));
    await h.db.query(`UPDATE invigilators SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [other.first.id]);
    await runFailover(h.db);
    expect(await watching(other.second.id)).toBe(1);
  });
});
