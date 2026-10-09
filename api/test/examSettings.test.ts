import { describe, expect, it } from 'vitest';
import { allocate } from '../src/allocation.js';
import { rotateSession } from '../src/failover.js';
import { shuffled } from '../src/modules/attempts.js';
import { releaseScheduledResults } from '../src/results.js';
import { approvedCandidate, call, createOrg, invigilator, login, minutesFromNow, PASSWORD, publishedExam, session, type TestOrg, uniq, useHarness } from './helpers.js';
import { buildExam, candidateReady } from './fixtures.js';

const h = useHarness();

/** A started attempt on the five question exam, with extra exam settings. */
async function startWith(org: TestOrg, extra: object) {
  const c = await candidateReady(h, org, { exam: await buildExam(h, org, undefined, undefined, extra) });
  const res = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
  expect(res.status).toBe(201);
  return { ...c, attemptId: res.body.id as string, start: res.body };
}

/** Right answers to the three choice questions; the two free text questions left blank. */
const choiceAnswers = (c: Awaited<ReturnType<typeof startWith>>) => {
  const [mcq, mr, tf] = c.questions;
  return [
    { questionId: mcq!.id, seq: 1, response: { optionId: mcq!.options['4'] } },
    { questionId: mr!.id, seq: 1, response: { optionIds: [mr!.options['2'], mr!.options['3']] } },
    { questionId: tf!.id, seq: 1, response: { optionId: tf!.options['True'] } },
  ];
};

async function staff(org: TestOrg, role: string) {
  const email = `${uniq(role)}@${org.slug}.example`;
  const res = await call(h, 'POST', `/organisations/${org.id}/users`, org.owner, { email, displayName: role, role, password: PASSWORD });
  expect(res.status).toBe(201);
  return (await login(h, org.slug, email)).accessToken;
}

describe('question order', () => {
  it('shuffles uniformly enough to reach every order of three', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(shuffled(['a', 'b', 'c']).join(''));
    expect(seen.size).toBe(6);
  });

  it('gives each candidate an order chosen at the start, kept on resume', async () => {
    const org = await createOrg(h);
    const c = await startWith(org, { navigation: { randomiseQuestionOrder: true } });
    const order = c.start.questionOrder as string[];
    expect([...order].sort()).toEqual(c.questions.map((q) => q.id).sort());
    const again = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    expect(again.body.questionOrder).toEqual(order);
    expect((await call(h, 'GET', `/attempts/${c.attemptId}`, c.token)).body.questionOrder).toEqual(order);
  });

  it('keeps the published order when the exam does not shuffle', async () => {
    const org = await createOrg(h);
    const c = await startWith(org, {});
    expect(c.start.questionOrder).toBeNull();
  });
});

describe('automatic marking off', () => {
  it('sends choice questions to a marker, who may score them', async () => {
    const org = await createOrg(h);
    const c = await startWith(org, { results: { autoMark: false } });
    await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, { answers: choiceAnswers(c) });
    const marking = await call(h, 'GET', `/marking/attempts/${c.attemptId}`, org.owner);
    expect(marking.body).toMatchObject({ needsManual: 3, status: 'pending', score: 0 });
    expect(marking.body.questions.filter((q: { auto: boolean }) => !q.auto)).toHaveLength(5);
    const [mcq, mr, tf] = c.questions;
    const put = await call(h, 'PUT', `/marking/attempts/${c.attemptId}`, org.owner, {
      marks: [
        { questionId: mcq!.id, points: 2 },
        { questionId: mr!.id, points: 1.5 },
        { questionId: tf!.id, points: 1 },
      ],
    });
    expect(put.body).toMatchObject({ score: 4.5, needsManual: 0, status: 'marked' });
  });

  it('refuses a human mark on a choice question when marking is automatic', async () => {
    const org = await createOrg(h);
    const c = await startWith(org, {});
    await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, { answers: choiceAnswers(c) });
    const put = await call(h, 'PUT', `/marking/attempts/${c.attemptId}`, org.owner, { marks: [{ questionId: c.questions[0]!.id, points: 2 }] });
    expect(put.status).toBe(400);
  });
});

describe('moderation', () => {
  it('holds results back until someone other than the marker confirms them', async () => {
    const org = await createOrg(h);
    const c = await startWith(org, { results: { moderation: true } });
    const essay = c.questions[4]!;
    await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, {
      answers: [...choiceAnswers(c), { questionId: essay.id, seq: 1, response: { text: 'An essay.' } }],
    });
    await call(h, 'PUT', `/marking/attempts/${c.attemptId}`, org.owner, { marks: [{ questionId: essay.id, points: 3 }] });

    const early = await call(h, 'POST', `/sessions/${c.sessionId}/results/release`, org.owner);
    expect(early.body).toEqual({ released: 0, stillPending: 0, awaitingModeration: 1 });
    // The owner marked the essay, so cannot moderate it.
    expect((await call(h, 'POST', `/marking/attempts/${c.attemptId}/moderate`, org.owner)).status).toBe(409);
    // A reviewer may look but not moderate.
    expect((await call(h, 'POST', `/marking/attempts/${c.attemptId}/moderate`, await staff(org, 'reviewer'))).status).toBe(403);

    const admin = await staff(org, 'admin');
    expect((await call(h, 'POST', `/marking/attempts/${c.attemptId}/moderate`, admin)).body).toEqual({ status: 'moderated' });
    const view = await call(h, 'GET', `/marking/attempts/${c.attemptId}`, org.owner);
    expect(view.body.moderation).toMatchObject({ required: true, moderatedBy: expect.stringContaining('admin') });

    // Changing a mark sends it back.
    await call(h, 'PUT', `/marking/attempts/${c.attemptId}`, org.owner, { marks: [{ questionId: essay.id, points: 4 }] });
    expect((await call(h, 'GET', `/marking/attempts/${c.attemptId}`, org.owner)).body.status).toBe('marked');
    await call(h, 'POST', `/marking/attempts/${c.attemptId}/moderate`, admin);
    const release = await call(h, 'POST', `/sessions/${c.sessionId}/results/release`, org.owner);
    expect(release.body).toEqual({ released: 1, stillPending: 0, awaitingModeration: 0 });
  });
});

describe('scheduled release', () => {
  it('releases marked results once the release date passes, and not before', async () => {
    const org = await createOrg(h);
    const later = await startWith(org, { results: { releaseAt: minutesFromNow(60) } });
    await call(h, 'POST', `/attempts/${later.attemptId}/submit`, later.token, { answers: choiceAnswers(later) });
    const due = await startWith(org, { results: { releaseAt: minutesFromNow(-1) } });
    await call(h, 'POST', `/attempts/${due.attemptId}/submit`, due.token, { answers: choiceAnswers(due) });

    await releaseScheduledResults(h.db);
    const status = async (attemptId: string) =>
      (await h.db.query<{ status: string; released_by: string | null }>('SELECT status, released_by FROM results WHERE attempt_id = $1', [attemptId])).rows[0]!;
    expect(await status(due.attemptId)).toEqual({ status: 'released', released_by: null });
    expect((await status(later.attemptId)).status).toBe('marked');
    expect((await call(h, 'GET', '/me/results', due.token)).body.items).toHaveLength(1);
    const { rows } = await h.db.query(`SELECT data FROM audit_logs WHERE target_id = $1 AND action = 'results.release'`, [due.sessionId]);
    expect(rows[0].data).toMatchObject({ released: 1, scheduled: true });
  });
});

describe('contact policy', () => {
  async function liveAttempt(org: TestOrg, communication: string) {
    const c = await startWith(org, { invigilation: { communication } });
    return c.attemptId;
  }

  it('blocks voice calls on a text only exam, but still allows watching', async () => {
    const org = await createOrg(h);
    const id = await liveAttempt(org, 'text');
    expect((await call(h, 'POST', `/live/attempts/${id}/calls`, org.owner, { voice: true })).status).toBe(409);
    expect((await call(h, 'POST', `/live/attempts/${id}/calls`, org.owner, { voice: false })).status).toBe(201);
    expect((await call(h, 'GET', `/live/attempts/${id}`, org.owner)).body.communication).toBe('text');
  });

  it('blocks chat on a voice only exam, but still sends rule warnings', async () => {
    const org = await createOrg(h);
    const id = await liveAttempt(org, 'voice');
    expect((await call(h, 'POST', `/live/attempts/${id}/messages`, org.owner, { kind: 'message', body: 'Hello' })).status).toBe(409);
    expect((await call(h, 'POST', `/live/attempts/${id}/messages`, org.owner, { kind: 'warning', body: 'Face the camera' })).status).toBe(201);
  });
});

describe('invigilator rotation', () => {
  it('steers each candidate to someone else where there is room', () => {
    const plan = allocate(['c1', 'c2'], [{ id: 'a', load: 0, capacity: 10 }, { id: 'b', load: 0, capacity: 10 }], {
      avoid: new Map([
        ['c1', 'a'],
        ['c2', 'b'],
      ]),
    });
    expect(plan.assignments).toEqual([
      { candidateId: 'c1', invigilatorId: 'b' },
      { candidateId: 'c2', invigilatorId: 'a' },
    ]);
  });

  it('moves candidates between present invigilators when the interval has passed', async () => {
    const org = await createOrg(h);
    const { versionId } = await publishedExam(h, org, 10, { invigilation: { required: true, rotationMinutes: 20 } });
    const sessionId = await session(h, org, versionId, { startsAt: minutesFromNow(-30), endsAt: minutesFromNow(120) });
    const ids = [await approvedCandidate(h, org), await approvedCandidate(h, org)];
    await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: ids });
    await call(h, 'PATCH', `/sessions/${sessionId}`, org.owner, { status: 'open' });
    const a = await invigilator(h, org);
    const b = await invigilator(h, org);
    await call(h, 'POST', `/sessions/${sessionId}/invigilators`, org.owner, { invigilatorIds: [a.id, b.id] });
    for (const inv of [a, b]) await call(h, 'GET', `/live/sessions/${sessionId}`, (await login(h, org.slug, inv.email)).accessToken);
    await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId });
    const who = async () =>
      new Map(
        (
          await h.db.query<{ candidate_id: string; invigilator_id: string }>(
            'SELECT candidate_id, invigilator_id FROM invigilation_assignments WHERE session_id = $1 AND active',
            [sessionId],
          )
        ).rows.map((r) => [r.candidate_id, r.invigilator_id]),
      );
    const before = await who();
    expect(before.size).toBe(2);

    expect(await rotateSession(h.db, sessionId)).toBe(2);
    const after = await who();
    for (const id of ids) expect(after.get(id)).not.toBe(before.get(id));
    // Not due again until another 20 minutes have passed.
    expect(await rotateSession(h.db, sessionId)).toBe(0);
    const { rows } = await h.db.query(`SELECT 1 FROM audit_logs WHERE target_id = $1 AND action = 'invigilation.rotate'`, [sessionId]);
    expect(rows).toHaveLength(1);
  });
});
