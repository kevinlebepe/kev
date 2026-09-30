import { describe, expect, it } from 'vitest';
import { markAttempt } from '../src/marking.js';
import { approvedCandidate, call, createOrg, login, minutesFromNow, passingReport, session, type TestOrg, uniq, useHarness } from './helpers.js';
import { started } from './fixtures.js';

const h = useHarness();

describe('partial credit', () => {
  const q = [{ id: 'm', type: 'multiple_response' }];
  const key = { m: { points: 4, correctOptionIds: ['a', 'b'] } };
  const mark = (ids: string[], policy: 'none' | 'proportional') => markAttempt(q, key, new Map([['m', { optionIds: ids }]]), new Map(), policy).score;

  it('gives a share for each correct choice, less each wrong one, never below zero', () => {
    expect(mark(['a', 'b'], 'proportional')).toBe(4);
    expect(mark(['a'], 'proportional')).toBe(2);
    expect(mark(['a', 'c'], 'proportional')).toBe(0);
    expect(mark(['c', 'd'], 'proportional')).toBe(0);
    expect(mark(['a', 'b', 'c'], 'proportional')).toBe(2);
  });

  it('stays all or nothing unless the exam chooses otherwise', () => {
    expect(mark(['a'], 'none')).toBe(0);
    expect(mark(['a', 'b'], 'none')).toBe(4);
  });
});

/** A candidate ready to start an exam with one file upload question, worth 5. */
async function fileExam(org: TestOrg, extra: object = {}) {
  const q = await call(h, 'POST', '/questions', org.owner, { type: 'file_upload', prompt: 'Upload your working.' });
  const exam = await call(h, 'POST', '/exams', org.owner, { code: uniq('F'), name: 'File exam', config: { timing: { durationMinutes: 60 }, ...extra } });
  await call(h, 'PUT', `/exams/${exam.body.id}/questions`, org.owner, { items: [{ questionId: q.body.id, points: 5 }] });
  const version = await call(h, 'POST', `/exams/${exam.body.id}/publish`, org.owner);
  const sessionId = await session(h, org, version.body.id, { startsAt: minutesFromNow(-1), endsAt: minutesFromNow(90) });
  const name = uniq('cand');
  const candidateId = await approvedCandidate(h, org, name);
  await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [candidateId] });
  const token = (await login(h, org.slug, `${name}@${org.slug}.example`)).accessToken;
  const assignmentId = (await call(h, 'GET', '/me/entitlements', token)).body.items[0].id as string;
  await call(h, 'POST', `/me/entitlements/${assignmentId}/precheck`, token, passingReport());
  return { questionId: q.body.id as string, sessionId, token, assignmentId };
}

const upload = (token: string, attemptId: string, questionId: string, body: Buffer, type = 'application/pdf') =>
  h.app.inject({
    method: 'POST',
    url: `/attempts/${attemptId}/files/${questionId}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': type, 'x-file-name': 'my working<script>.pdf' },
    payload: body,
  });

describe('file upload questions', () => {
  it('takes a file as the answer, and a marker downloads and marks it', async () => {
    const org = await createOrg(h);
    const c = await fileExam(org);
    const attemptId = (await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId })).body.id;

    expect((await upload(c.token, attemptId, c.questionId, Buffer.from('x'), 'text/html')).statusCode).toBe(415);
    const sent = await upload(c.token, attemptId, c.questionId, Buffer.from('%PDF-1.4 working'));
    expect(sent.statusCode).toBe(201);
    const { fileId, name } = sent.json();
    expect(name).toBe('my working_script_.pdf');

    // Someone else's file id is refused as an answer.
    const other = await fileExam(org);
    const otherAttempt = (await call(h, 'POST', '/attempts/start', other.token, { assignmentId: other.assignmentId })).body.id;
    const bad = await call(h, 'PATCH', `/attempts/${otherAttempt}/state`, other.token, { answers: [{ questionId: other.questionId, seq: 1, response: { fileId } }] });
    expect(bad.status).toBe(400);

    await call(h, 'POST', `/attempts/${attemptId}/submit`, c.token, { answers: [{ questionId: c.questionId, seq: 1, response: { fileId, name } }] });
    const marking = await call(h, 'GET', `/marking/attempts/${attemptId}`, org.owner);
    expect(marking.body).toMatchObject({ needsManual: 1, status: 'pending' });
    expect(marking.body.questions[0].answer).toEqual({ fileId, name });

    const file = await h.app.inject({ method: 'GET', url: `/marking/attempts/${attemptId}/files/${fileId}`, headers: { authorization: `Bearer ${org.owner}` } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toBe('attachment; filename="my working_script_.pdf"');
    expect(file.body).toBe('%PDF-1.4 working');
    expect((await call(h, 'GET', `/marking/attempts/${attemptId}/files/${fileId}`, c.token)).status).toBe(403);

    const marked = await call(h, 'PUT', `/marking/attempts/${attemptId}`, org.owner, { marks: [{ questionId: c.questionId, points: 4 }] });
    expect(marked.body).toMatchObject({ score: 4, maxScore: 5, status: 'marked' });
  });

  it('refuses files after the exam has closed', async () => {
    const org = await createOrg(h);
    const c = await fileExam(org);
    const attemptId = (await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId })).body.id;
    await call(h, 'POST', `/attempts/${attemptId}/submit`, c.token, {});
    expect((await upload(c.token, attemptId, c.questionId, Buffer.from('late'))).statusCode).toBe(409);
  });
});

describe('extra time for a candidate', () => {
  it('lengthens the exam when it starts, and moves the deadline of a running one', async () => {
    const org = await createOrg(h);
    const c = await fileExam(org);
    const set = await call(h, 'PATCH', `/assignments/${c.assignmentId}`, org.owner, { extraMinutes: 20, reason: 'Dyslexia accommodation' });
    expect(set.body.extraMinutes).toBe(20);
    const start = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    const minutes = (Date.parse(start.body.deadlineAt) - Date.parse(start.body.startedAt)) / 60_000;
    expect(minutes).toBeCloseTo(80, 0);

    const more = await call(h, 'PATCH', `/assignments/${c.assignmentId}`, org.owner, { extraMinutes: 30, reason: 'Updated letter' });
    expect(Date.parse(more.body.deadlineAt) - Date.parse(start.body.deadlineAt)).toBe(10 * 60_000);
    const list = await call(h, 'GET', `/sessions/${c.sessionId}/attempts`, org.owner);
    expect(list.body.items[0].extraMinutes).toBe(30);

    await call(h, 'POST', `/attempts/${start.body.id}/submit`, c.token, {});
    expect((await call(h, 'PATCH', `/assignments/${c.assignmentId}`, org.owner, { extraMinutes: 40, reason: 'x' })).status).toBe(409);
    const outsider = await createOrg(h);
    expect((await call(h, 'PATCH', `/assignments/${c.assignmentId}`, outsider.owner, { extraMinutes: 5, reason: 'x' })).status).toBe(404);
  });
});

describe('retakes', () => {
  it('are a new assignment to another session, keeping the first attempt', async () => {
    const org = await createOrg(h);
    const first = await started(h, org);
    await call(h, 'POST', `/attempts/${first.attemptId}/submit`, first.token, {});
    const again = await session(h, org, first.versionId, { startsAt: minutesFromNow(-1), endsAt: minutesFromNow(120) });
    const res = await call(h, 'POST', '/assignments', org.owner, { sessionId: again, candidateIds: [first.candidateId] });
    expect(res.body.assigned).toEqual([first.candidateId]);
    const mine = await call(h, 'GET', '/me/entitlements', first.token);
    expect(mine.body.items.map((i: { status: string }) => i.status).sort()).toEqual(['assigned', 'submitted']);
  });
});
