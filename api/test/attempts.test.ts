import { createPublicKey, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { finalizeAttempt, finalizeExpiredAttempts, receiptPayload } from '../src/attempts.js';
import { withTransaction } from '../src/db.js';
import { verifyManifest } from '../src/signing.js';
import {
  approvedCandidate,
  call,
  createOrg,
  login,
  minutesFromNow,
  passingReport,
  session,
  type TestOrg,
  uniq,
  useHarness,
} from './helpers.js';

const h = useHarness();

import * as fx from './fixtures.js';

type Q = fx.Q;

const buildExam = (org: TestOrg, security?: object, device?: object) => fx.buildExam(h, org, security, device);
const candidateReady = (org: TestOrg, opts: Parameters<typeof fx.candidateReady>[2] = {}) => fx.candidateReady(h, org, opts);
const started = (org: TestOrg, security?: object) => fx.started(h, org, security);

const answer = (questionId: string, seq: number, response: object) => ({ questionId, seq, response });

describe('starting an attempt', () => {
  it('needs a passed device check', async () => {
    const org = await createOrg(h);
    const c = await candidateReady(org, { precheck: false });
    const res = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/device check/);
  });

  it('is refused before the session starts and after the start window closes', async () => {
    const org = await createOrg(h);
    const early = await candidateReady(org, { times: { startsAt: minutesFromNow(30), endsAt: minutesFromNow(200) } });
    const tooEarly = await call(h, 'POST', '/attempts/start', early.token, { assignmentId: early.assignmentId });
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.message).toMatch(/starts at/);

    const late = await candidateReady(org, { times: { startsAt: minutesFromNow(-60), endsAt: minutesFromNow(120) } });
    const tooLate = await call(h, 'POST', '/attempts/start', late.token, { assignmentId: late.assignmentId });
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.error.message).toMatch(/start window/);
  });

  it('sets a server side deadline and resumes instead of starting twice', async () => {
    const org = await createOrg(h);
    const c = await candidateReady(org);
    const first = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    expect(first.status).toBe(201);
    expect(first.body.resumed).toBe(false);
    const minutes = (Date.parse(first.body.deadlineAt) - Date.parse(first.body.startedAt)) / 60_000;
    expect(minutes).toBeCloseTo(60, 1);
    expect(Math.abs(Date.parse(first.body.serverTime) - Date.now())).toBeLessThan(5_000);

    const again = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, resumed: true, deadlineAt: first.body.deadlineAt });

    const { rows } = await h.db.query('SELECT status FROM exam_assignments WHERE id = $1', [c.assignmentId]);
    expect(rows[0].status).toBe('active');
  });

  it('creates exactly one attempt when starts arrive at the same moment', async () => {
    const org = await createOrg(h);
    const c = await candidateReady(org);
    // A double click, a second tab, or a retry can all send starts together.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const { rows } = await h.db.query('SELECT count(*)::int AS n FROM attempts WHERE assignment_id = $1', [c.assignmentId]);
    expect(rows[0].n).toBe(1);
  });

  it('resumes, rather than refusing, when it had to wait for a start that won the race', async () => {
    const org = await createOrg(h);
    const c = await candidateReady(org);
    // Hold the entitlement locked, as a concurrent start would while it works.
    const winner = await h.db.connect();
    await winner.query('BEGIN');
    await winner.query('SELECT 1 FROM exam_assignments WHERE id = $1 FOR UPDATE', [c.assignmentId]);

    const waiting = call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    await new Promise((r) => setTimeout(r, 300)); // let the request reach the lock and block

    // The winner creates the attempt and commits while the other request is still waiting.
    await winner.query(
      `INSERT INTO attempts (organisation_id, assignment_id, exam_version_id, deadline_at)
       SELECT a.organisation_id, a.id, s.exam_version_id, now() + interval '1 hour'
         FROM exam_assignments a JOIN sessions s ON s.id = a.session_id WHERE a.id = $1`,
      [c.assignmentId],
    );
    await winner.query(`UPDATE exam_assignments SET status = 'active' WHERE id = $1`, [c.assignmentId]);
    await winner.query('COMMIT');
    winner.release();

    const res = await waiting;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resumed: true, status: 'active' });
  });

  it('caps the deadline at the end of the session', async () => {
    const org = await createOrg(h);
    const c = await candidateReady(org, { times: { startsAt: minutesFromNow(-1), endsAt: minutesFromNow(20) } });
    const res = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    expect((Date.parse(res.body.deadlineAt) - Date.now()) / 60_000).toBeLessThan(20.1);
  });

  it('is private to the candidate who owns the entitlement', async () => {
    const org = await createOrg(h);
    const a = await started(org);
    const b = await candidateReady(org, { exam: { versionId: a.versionId, questions: a.questions } });
    expect((await call(h, 'GET', `/attempts/${a.attemptId}`, b.token)).status).toBe(404);
    expect((await call(h, 'POST', '/attempts/start', b.token, { assignmentId: a.assignmentId })).status).toBe(404);
    expect((await call(h, 'GET', `/attempts/${a.attemptId}`, org.owner)).status).toBe(403);

    const other = await createOrg(h);
    expect((await call(h, 'GET', `/attempts/${a.attemptId}`, other.owner)).status).toBe(403);
  });
});

describe('saving answers', () => {
  it('stores answers, returns them on resume, and never exposes the answer key', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const [q1, , , q4] = c.questions as [Q, Q, Q, Q, Q];
    const saved = await call(h, 'PATCH', `/attempts/${c.attemptId}/state`, c.token, {
      answers: [answer(q1.id, 1, { optionId: q1.options['4'] }), answer(q4.id, 2, { text: 'Paris' })],
      position: 3,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.acked).toEqual(expect.arrayContaining([{ questionId: q1.id, seq: 1 }, { questionId: q4.id, seq: 2 }]));

    const resumed = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    expect(resumed.body.position).toBe(3);
    expect(resumed.body.answers).toHaveLength(2);
    expect(JSON.stringify(resumed.body)).not.toMatch(/score|isCorrect|correct/i);
  });

  it('keeps the newest answer whatever order requests arrive in', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const q1 = c.questions[0]!;
    const url = `/attempts/${c.attemptId}/state`;
    await call(h, 'PATCH', url, c.token, { answers: [answer(q1.id, 5, { optionId: q1.options['4'] })] });
    // A delayed older request arrives afterwards.
    const stale = await call(h, 'PATCH', url, c.token, { answers: [answer(q1.id, 3, { optionId: q1.options['3'] })] });
    expect(stale.body.acked).toEqual([{ questionId: q1.id, seq: 5 }]);
    // Replaying the same request changes nothing.
    await call(h, 'PATCH', url, c.token, { answers: [answer(q1.id, 5, { optionId: q1.options['4'] })] });
    // Within one batch the highest seq wins regardless of position.
    const batch = await call(h, 'PATCH', url, c.token, {
      answers: [answer(q1.id, 9, { optionId: q1.options['5'] }), answer(q1.id, 7, { optionId: q1.options['3'] })],
    });
    expect(batch.body.acked).toEqual([{ questionId: q1.id, seq: 9 }]);

    const view = await call(h, 'GET', `/attempts/${c.attemptId}`, c.token);
    expect(view.body.answers).toEqual([{ questionId: q1.id, seq: 9, response: { optionId: q1.options['5'] } }]);
  });

  it('rejects answers that do not fit the question', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const [q1, q2, , q4] = c.questions as [Q, Q, Q, Q, Q];
    const url = `/attempts/${c.attemptId}/state`;
    const bad = async (a: object) => (await call(h, 'PATCH', url, c.token, { answers: [a] })).status;

    expect(await bad(answer(q1.id, 1, { optionId: '00000000-0000-4000-8000-000000000000' }))).toBe(400); // unknown option
    expect(await bad(answer(q1.id, 1, { text: 'four' }))).toBe(400); // wrong shape for mcq
    expect(await bad(answer(q2.id, 1, { optionIds: [q2.options['2'], q2.options['2']] }))).toBe(400); // repeated option
    expect(await bad(answer(q4.id, 1, { text: 'x'.repeat(2001) }))).toBe(400); // too long
    expect(await bad(answer('00000000-0000-4000-8000-000000000000', 1, { text: 'x' }))).toBe(400); // not in this exam
    expect(await bad(answer(q1.id, 0, { optionId: q1.options['4'] }))).toBe(400); // seq must be positive
    expect(await bad({ questionId: q1.id, seq: 1, response: { optionId: q1.options['4'], extra: true } })).toBe(400); // unknown field

    const view = await call(h, 'GET', `/attempts/${c.attemptId}`, c.token);
    expect(view.body.answers).toEqual([]);
  });

  it('rejects the whole batch when one answer is invalid, saving nothing', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const [q1, , , q4] = c.questions as [Q, Q, Q, Q, Q];
    const res = await call(h, 'PATCH', `/attempts/${c.attemptId}/state`, c.token, {
      answers: [answer(q1.id, 1, { optionId: q1.options['4'] }), answer(q4.id, 2, { optionId: q1.options['4'] })],
    });
    expect(res.status).toBe(400);
    expect((await call(h, 'GET', `/attempts/${c.attemptId}`, c.token)).body.answers).toEqual([]);
  });
});

describe('the deadline', () => {
  it('still accepts a save just after the deadline, inside the grace period', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    await h.db.query(`UPDATE attempts SET deadline_at = now() - interval '5 seconds' WHERE id = $1`, [c.attemptId]);
    const res = await call(h, 'PATCH', `/attempts/${c.attemptId}/state`, c.token, {
      answers: [answer(c.questions[0]!.id, 1, { optionId: c.questions[0]!.options['4'] })],
    });
    expect(res.status).toBe(200);
  });

  it('closes the attempt when a save arrives after the grace period', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const q1 = c.questions[0]!;
    await call(h, 'PATCH', `/attempts/${c.attemptId}/state`, c.token, { answers: [answer(q1.id, 1, { optionId: q1.options['4'] })] });
    await h.db.query(`UPDATE attempts SET deadline_at = now() - interval '2 minutes' WHERE id = $1`, [c.attemptId]);

    const late = await call(h, 'PATCH', `/attempts/${c.attemptId}/state`, c.token, {
      answers: [answer(q1.id, 2, { optionId: q1.options['3'] })],
    });
    expect(late.status).toBe(409);
    expect(late.body.error.details.receipt).toMatchObject({ submittedBy: 'timer', answered: 1 });

    // The late change was not applied: the saved answer is what gets marked.
    const { rows } = await h.db.query(`SELECT score::float AS score FROM results WHERE attempt_id = $1`, [c.attemptId]);
    expect(rows[0].score).toBe(2);
  });

  it('submits overdue attempts in the background, leaving healthy ones alone', async () => {
    const org = await createOrg(h);
    const overdue = await started(org);
    const healthy = await started(org);
    await h.db.query(`UPDATE attempts SET deadline_at = now() - interval '2 minutes' WHERE id = $1`, [overdue.attemptId]);

    expect(await finalizeExpiredAttempts(h.db, h.config)).toBeGreaterThanOrEqual(1);
    expect(await finalizeExpiredAttempts(h.db, h.config)).toBe(0); // nothing left to do

    const view = await call(h, 'GET', `/attempts/${overdue.attemptId}`, overdue.token);
    expect(view.body).toMatchObject({ status: 'submitted', receipt: { submittedBy: 'timer' } });
    expect((await call(h, 'GET', `/attempts/${healthy.attemptId}`, healthy.token)).body.status).toBe('active');

    const { rows } = await h.db.query(`SELECT type FROM events WHERE attempt_id = $1 ORDER BY occurred_at`, [overdue.attemptId]);
    expect(rows.map((r) => r.type)).toEqual(['attempt_started', 'attempt_auto_submitted']);
  });

  it('closes an expired attempt when the candidate comes back to it', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    await h.db.query(`UPDATE attempts SET deadline_at = now() - interval '2 minutes' WHERE id = $1`, [c.attemptId]);
    const res = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    expect(res.body).toMatchObject({ status: 'submitted', resumed: true, receipt: { submittedBy: 'timer' } });
  });
});

describe('submitting', () => {
  it('marks what it can, keeps free text for a human, and hides the score from the candidate', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const [q1, q2, q3, q4, q5] = c.questions as [Q, Q, Q, Q, Q];
    const res = await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, {
      answers: [
        answer(q1.id, 1, { optionId: q1.options['4'] }), // correct: 2
        answer(q2.id, 2, { optionIds: [q2.options['2'], q2.options['3']] }), // correct: 3
        answer(q3.id, 3, { optionId: q3.options['False'] }), // wrong: 0
        answer(q4.id, 4, { text: 'Paris' }), // manual
        answer(q5.id, 5, { text: 'An essay.' }), // manual
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.receipt).toMatchObject({ submittedBy: 'candidate', answered: 5, total: 5 });

    const { rows } = await h.db.query(`SELECT score::float AS score, max_score::float AS max, status FROM results WHERE attempt_id = $1`, [c.attemptId]);
    expect(rows[0]).toEqual({ score: 5, max: 11, status: 'pending' });

    const view = await call(h, 'GET', `/attempts/${c.attemptId}`, c.token);
    expect(view.body.status).toBe('submitted');
    expect(JSON.stringify(view.body)).not.toMatch(/score|max_score/i);

    // The organisation can see it.
    const list = await call(h, 'GET', `/sessions/${c.sessionId}/attempts`, org.owner);
    expect(list.body.items[0]).toMatchObject({ status: 'submitted', score: 5, maxScore: 11, markingStatus: 'pending', submittedBy: 'candidate' });
    expect((await call(h, 'GET', `/sessions/${c.sessionId}/attempts`, c.token)).status).toBe(403);
  });

  it('treats all or nothing for multiple response and marks fully automatic exams as done', async () => {
    const org = await createOrg(h);
    const exam = await (async () => {
      const q = await call(h, 'POST', '/questions', org.owner, {
        type: 'multiple_response',
        prompt: 'Pick the primes',
        options: [{ label: '2', isCorrect: true }, { label: '3', isCorrect: true }, { label: '4' }],
      });
      const e = await call(h, 'POST', '/exams', org.owner, { code: uniq('EX'), name: 'Auto', config: { timing: { durationMinutes: 30 } } });
      await call(h, 'PUT', `/exams/${e.body.id}/questions`, org.owner, { items: [{ questionId: q.body.id, points: 2 }] });
      const v = await call(h, 'POST', `/exams/${e.body.id}/publish`, org.owner);
      const pkg = await call(h, 'GET', `/exam-versions/${v.body.id}/package`, org.owner);
      const mq = pkg.body.manifest.questions[0];
      return {
        versionId: v.body.id as string,
        questions: [{ id: mq.id as string, prompt: mq.prompt as string, options: Object.fromEntries(mq.options.map((o: { id: string; label: string }) => [o.label, o.id])) }],
      };
    })();
    const c = await candidateReady(org, { exam });
    const attempt = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    const q = c.questions[0]!;
    // Only one of the two correct options: no credit.
    await call(h, 'POST', `/attempts/${attempt.body.id}/submit`, c.token, { answers: [answer(q.id, 1, { optionIds: [q.options['2']] })] });
    const { rows } = await h.db.query(`SELECT score::float AS score, status FROM results WHERE attempt_id = $1`, [attempt.body.id]);
    expect(rows[0]).toEqual({ score: 0, status: 'marked' });
  });

  it('gives the same receipt however many times, or how concurrently, it is submitted', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const q1 = c.questions[0]!;
    const body = { answers: [answer(q1.id, 1, { optionId: q1.options['4'] })] };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, body)),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.receipt.receiptId)).size).toBe(1);

    const { rows } = await h.db.query(`SELECT count(*)::int AS n FROM submissions WHERE attempt_id = $1`, [c.attemptId]);
    expect(rows[0].n).toBe(1);
    const { rows: res } = await h.db.query(`SELECT count(*)::int AS n FROM results WHERE attempt_id = $1`, [c.attemptId]);
    expect(res[0].n).toBe(1);
  });

  it('finalising twice returns the original receipt and writes nothing new', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const first = await withTransaction(h.db, (tx) => finalizeAttempt(tx, h.config, c.attemptId, 'candidate', { userId: null }));
    const second = await withTransaction(h.db, (tx) => finalizeAttempt(tx, h.config, c.attemptId, 'timer', { userId: null }));
    expect(second).toEqual(first);
    expect(second.submittedBy).toBe('candidate');
    for (const table of ['submissions', 'results']) {
      const { rows } = await h.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE attempt_id = $1`, [c.attemptId]);
      expect(rows[0].n).toBe(1);
    }
  });

  it('issues a receipt the candidate can verify, bound to exactly what was submitted', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const q1 = c.questions[0]!;
    const res = await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, { answers: [answer(q1.id, 1, { optionId: q1.options['4'] })] });
    const { signature, ...fields } = res.body.receipt;
    const key = createPublicKey((await call(h, 'GET', '/exam-signing-key')).body.publicKeyPem);
    expect(verifyManifest(receiptPayload(fields), signature, key)).toBe(true);
    expect(verifyManifest(receiptPayload({ ...fields, answered: 99 }), signature, key)).toBe(false);

    // A retry returns exactly the same receipt as the first response.
    const retry = await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, {});
    expect(retry.body.receipt).toEqual(res.body.receipt);
    expect(res.body.receipt.packageSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts nothing further once submitted, and blocks re-entry', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const q1 = c.questions[0]!;
    await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, {});

    const save = await call(h, 'PATCH', `/attempts/${c.attemptId}/state`, c.token, { answers: [answer(q1.id, 1, { optionId: q1.options['4'] })] });
    expect(save.status).toBe(409);
    expect((await call(h, 'GET', `/attempts/${c.attemptId}`, c.token)).body.answers).toEqual([]);

    const entitlements = await call(h, 'GET', '/me/entitlements', c.token);
    expect(entitlements.body.items[0].status).toBe('submitted');
    expect((await call(h, 'GET', `/me/entitlements/${c.assignmentId}/package`, c.token)).status).toBe(409);
  });

  it('records the attempt in the audit trail', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, {});
    const log = await call(h, 'GET', '/audit?limit=100', org.owner);
    const actions = log.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['attempt.start', 'attempt.submit']));
  });
});

// ---------------------------------------------------------------------------
// Exam rules: the app reports, the server counts and decides.
// ---------------------------------------------------------------------------

const ev = (type: string, extra: object = {}) => ({ id: randomUUID(), type, occurredAt: new Date().toISOString(), ...extra });
const postEvents = (c: { attemptId: string; token: string }, ...events: object[]) =>
  call(h, 'POST', `/attempts/${c.attemptId}/events`, c.token, { events });

describe('exam rules', () => {
  it('records events once, however many times the same report is sent', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    const event = ev('left_window', { data: { reason: 'tab_hidden' } });
    const first = await postEvents(c, event);
    const again = await postEvents(c, event); // a retry after a lost response
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ violations: 1, action: 'recorded', policy: 'flag' });
    expect(again.body.violations).toBe(1);

    const { rows } = await h.db.query(`SELECT count(*)::int AS n FROM events WHERE attempt_id = $1 AND type = 'left_window'`, [c.attemptId]);
    expect(rows[0].n).toBe(1);
  });

  it('under the flag policy only records, however often the candidate leaves', async () => {
    const org = await createOrg(h);
    const c = await started(org, { violationPolicy: 'flag' });
    for (let i = 0; i < 6; i++) await postEvents(c, ev('left_fullscreen'), ev('returned_fullscreen'));
    const res = await postEvents(c, ev('close_attempt'));
    expect(res.body).toMatchObject({ violations: 7, action: 'recorded' });
    expect((await call(h, 'GET', `/attempts/${c.attemptId}`, c.token)).body.status).toBe('active');
  });

  it('records blocked copy, paste and shortcut attempts without counting them', async () => {
    const org = await createOrg(h);
    const c = await started(org, { violationPolicy: 'submit_immediately' });
    const res = await postEvents(c, ev('copy_attempt'), ev('cut_attempt'), ev('paste_attempt'), ev('context_menu'), ev('shortcut_blocked', { data: { key: 'F12' } }));
    expect(res.body).toMatchObject({ violations: 0, action: 'none' });
    expect((await call(h, 'GET', `/attempts/${c.attemptId}`, c.token)).body.status).toBe('active');
    const timeline = await call(h, 'GET', `/attempts/${c.attemptId}/timeline`, org.owner);
    expect(timeline.body.items.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['copy_attempt', 'cut_attempt', 'paste_attempt', 'shortcut_blocked']),
    );
  });

  it('warns, then ends the exam once the allowed number is exceeded', async () => {
    const org = await createOrg(h);
    const c = await started(org, { violationPolicy: 'warn_then_submit', maxViolations: 2 });
    const q1 = c.questions[0]!;
    await call(h, 'PATCH', `/attempts/${c.attemptId}/state`, c.token, { answers: [answer(q1.id, 1, { optionId: q1.options['4'] })] });

    expect((await postEvents(c, ev('left_window'))).body).toMatchObject({ violations: 1, action: 'warned', maxViolations: 2 });
    expect((await postEvents(c, ev('left_fullscreen'))).body).toMatchObject({ violations: 2, action: 'warned' });
    const third = await postEvents(c, ev('close_attempt'));
    expect(third.body).toMatchObject({ violations: 3, action: 'ended', receipt: { submittedBy: 'system', answered: 1 } });

    // What was saved is kept and marked; nothing more is accepted.
    const { rows } = await h.db.query(`SELECT score::float AS score FROM results WHERE attempt_id = $1`, [c.attemptId]);
    expect(rows[0].score).toBe(2);
    expect((await call(h, 'PATCH', `/attempts/${c.attemptId}/state`, c.token, { answers: [] })).status).toBe(409);
    expect((await call(h, 'GET', '/me/entitlements', c.token)).body.items[0].status).toBe('submitted');

    const timeline = await call(h, 'GET', `/attempts/${c.attemptId}/timeline`, org.owner);
    const types = timeline.body.items.map((e: { type: string }) => e.type);
    expect(types).toEqual(['attempt_started', 'left_window', 'left_fullscreen', 'close_attempt', 'attempt_ended_for_rules', 'attempt_auto_submitted']);
  });

  it('ends the exam at the first violation under the strictest policy', async () => {
    const org = await createOrg(h);
    const c = await started(org, { violationPolicy: 'submit_immediately' });
    const res = await postEvents(c, ev('left_window'));
    expect(res.body).toMatchObject({ violations: 1, action: 'ended', receipt: { submittedBy: 'system' } });
  });

  it('applies the exam policy the organisation published, not one the app claims', async () => {
    const org = await createOrg(h);
    const c = await started(org); // default policy: flag
    const res = await call(h, 'POST', `/attempts/${c.attemptId}/events`, c.token, {
      events: [ev('left_window')],
      policy: 'submit_immediately', // ignored
    });
    expect(res.body).toMatchObject({ policy: 'flag', action: 'recorded' });
  });

  it('replaces an implausible device time with the server time', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    await postEvents(c, ev('left_window', { occurredAt: '2001-01-01T00:00:00Z' }), ev('returned_window', { occurredAt: '2099-01-01T00:00:00Z' }));
    const { rows } = await h.db.query(
      `SELECT count(*)::int AS n FROM events e JOIN attempts a ON a.id = e.attempt_id
        WHERE e.attempt_id = $1 AND e.type IN ('left_window', 'returned_window') AND e.occurred_at BETWEEN a.started_at AND now()`,
      [c.attemptId],
    );
    expect(rows[0].n).toBe(2);
  });

  it('refuses reports for a closed attempt, returning the receipt', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, {});
    const res = await postEvents(c, ev('left_window'));
    expect(res.status).toBe(409);
    expect(res.body.error.details.receipt).toMatchObject({ submittedBy: 'candidate' });
  });

  it('validates reports and keeps them private to the candidate', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    expect((await postEvents(c, ev('made_up_event'))).status).toBe(400);
    expect((await postEvents(c)).status).toBe(400);
    expect((await postEvents(c, { id: 'not-a-uuid', type: 'left_window', occurredAt: new Date().toISOString() })).status).toBe(400);
    expect((await postEvents(c, ...Array.from({ length: 51 }, () => ev('context_menu')))).status).toBe(400);

    const other = await candidateReady(org, { exam: { versionId: c.versionId, questions: c.questions } });
    expect((await call(h, 'POST', `/attempts/${c.attemptId}/events`, other.token, { events: [ev('left_window')] })).status).toBe(404);
    expect((await call(h, 'POST', `/attempts/${c.attemptId}/events`, org.owner, { events: [ev('left_window')] })).status).toBe(403);
  });

  it('gives the organisation the timeline and the violation count, and nobody else', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    await postEvents(c, ev('left_window'), ev('returned_window'), ev('left_fullscreen'));

    const timeline = await call(h, 'GET', `/attempts/${c.attemptId}/timeline`, org.owner);
    expect(timeline.body.items.map((e: { type: string }) => e.type)).toEqual(['attempt_started', 'left_window', 'returned_window', 'left_fullscreen']);
    expect(timeline.body.items[1].severity).toBe('high');

    const list = await call(h, 'GET', `/sessions/${c.sessionId}/attempts`, org.owner);
    expect(list.body.items[0]).toMatchObject({ violations: 2 });

    expect((await call(h, 'GET', `/attempts/${c.attemptId}/timeline`, c.token)).status).toBe(403);
    const other = await createOrg(h);
    expect((await call(h, 'GET', `/attempts/${c.attemptId}/timeline`, other.owner)).status).toBe(404);
  });

  it('puts the rules into the signed exam package', async () => {
    const org = await createOrg(h);
    const exam = await buildExam(org, { violationPolicy: 'warn_then_submit', maxViolations: 4, fullscreen: false });
    const pkg = await call(h, 'GET', `/exam-versions/${exam.versionId}/package`, org.owner);
    expect(pkg.body.manifest.config.security).toMatchObject({
      violationPolicy: 'warn_then_submit',
      maxViolations: 4,
      fullscreen: false,
      blockClipboard: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Exams that can only be taken in the ExamGuard desktop application.
// ---------------------------------------------------------------------------

const DESKTOP = { 'x-examguard-client': 'desktop' };
const desktopReport = () => ({ ...passingReport(), appKind: 'desktop' });

describe('desktop only exams', () => {
  async function desktopExam(org: TestOrg) {
    const exam = await buildExam(org, undefined, { requireDesktopApp: true, supportedOs: ['windows', 'macos', 'linux', 'chromeos', 'android', 'ios'] });
    const sessionId = await session(h, org, exam.versionId, { startsAt: minutesFromNow(-1), endsAt: minutesFromNow(180) });
    const name = uniq('cand');
    const candidateId = await approvedCandidate(h, org, name);
    await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [candidateId] });
    const { accessToken: token } = await login(h, org.slug, `${name}@${org.slug}.example`);
    const assignmentId = (await call(h, 'GET', '/me/entitlements', token)).body.items[0].id as string;
    return { ...exam, sessionId, token, assignmentId };
  }

  it('fails the device check in a browser and passes it in the desktop application', async () => {
    const org = await createOrg(h);
    const c = await desktopExam(org);
    const inBrowser = await call(h, 'POST', `/me/entitlements/${c.assignmentId}/precheck`, c.token, passingReport());
    expect(inBrowser.body.passed).toBe(false);
    expect(inBrowser.body.checks.filter((x: { passed: boolean }) => !x.passed).map((x: { key: string }) => x.key)).toEqual(['desktop_app']);

    const inApp = await call(h, 'POST', `/me/entitlements/${c.assignmentId}/precheck`, c.token, desktopReport(), DESKTOP);
    expect(inApp.body.passed).toBe(true);
  });

  it('keeps the questions and the attempt away from a browser', async () => {
    const org = await createOrg(h);
    const c = await desktopExam(org);
    await call(h, 'POST', `/me/entitlements/${c.assignmentId}/precheck`, c.token, desktopReport(), DESKTOP);

    const pkg = await call(h, 'GET', `/me/entitlements/${c.assignmentId}/package`, c.token);
    expect(pkg.status).toBe(409);
    expect(pkg.body.error.message).toMatch(/desktop application/);
    expect(JSON.stringify(pkg.body)).not.toMatch(/What is 2/); // no questions leak in the refusal

    const start = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
    expect(start.status).toBe(409);
    expect(start.body.error.message).toMatch(/desktop application/);
    const { rows } = await h.db.query('SELECT count(*)::int AS n FROM attempts WHERE assignment_id = $1', [c.assignmentId]);
    expect(rows[0].n).toBe(0);
  });

  it('lets a tablet, phone or Chromebook use the browser instead', async () => {
    for (const platform of ['ios', 'android', 'chromeos']) {
      const org = await createOrg(h);
      const c = await desktopExam(org);
      const report = { ...passingReport(), os: { platform, version: '17' } };
      const check = await call(h, 'POST', `/me/entitlements/${c.assignmentId}/precheck`, c.token, report);
      expect(check.body.passed, platform).toBe(true);
      expect((await call(h, 'GET', `/me/entitlements/${c.assignmentId}/package`, c.token)).status, platform).toBe(200);
      expect((await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId })).status, platform).toBe(201);
    }
  });

  it('still refuses a browser that says it is on a computer, and one that says nothing useful', async () => {
    for (const platform of ['windows', 'macos', 'linux', 'other']) {
      const org = await createOrg(h);
      const c = await desktopExam(org);
      const report = { ...passingReport(), os: { platform, version: '1' } };
      const check = await call(h, 'POST', `/me/entitlements/${c.assignmentId}/precheck`, c.token, report);
      const failed = check.body.checks.filter((x: { passed: boolean }) => !x.passed).map((x: { key: string }) => x.key);
      expect(failed, platform).toContain('desktop_app');
    }
  });

  it('lets the desktop application download, start and finish the exam', async () => {
    const org = await createOrg(h);
    const c = await desktopExam(org);
    await call(h, 'POST', `/me/entitlements/${c.assignmentId}/precheck`, c.token, desktopReport(), DESKTOP);
    expect((await call(h, 'GET', `/me/entitlements/${c.assignmentId}/package`, c.token, undefined, DESKTOP)).status).toBe(200);
    const start = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId }, DESKTOP);
    expect(start.status).toBe(201);
    const submit = await call(h, 'POST', `/attempts/${start.body.id}/submit`, c.token, {}, DESKTOP);
    expect(submit.status).toBe(200);
  });

  it('does not restrict exams that allow browsers', async () => {
    const org = await createOrg(h);
    const c = await started(org);
    expect(c.attemptId).toBeTruthy(); // the default exam started from a plain client
  });

  it('counts a screen added during the exam as a violation', async () => {
    const org = await createOrg(h);
    const c = await started(org, { violationPolicy: 'submit_immediately' });
    const res = await postEvents(c, ev('display_added', { data: { count: 2 } }));
    expect(res.body).toMatchObject({ violations: 1, action: 'ended', receipt: { submittedBy: 'system' } });
  });
});
