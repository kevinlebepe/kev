import { describe, expect, it } from 'vitest';
import { call, createOrg, PASSWORD, login, type TestOrg, useHarness } from './helpers.js';
import { started } from './fixtures.js';

const h = useHarness();

/** A submitted attempt: 2 + 3 marks correct, a short answer and an essay waiting for a marker. */
async function submitted(org: TestOrg) {
  const c = await started(h, org);
  const [mcq, multi, , short, essay] = c.questions;
  const answers = [
    { questionId: mcq!.id, seq: 1, response: { optionId: mcq!.options['4'] } },
    { questionId: multi!.id, seq: 1, response: { optionIds: [multi!.options['2'], multi!.options['3']] } },
    { questionId: short!.id, seq: 1, response: { text: 'Paris' } },
    { questionId: essay!.id, seq: 1, response: { text: '=HYPERLINK("http://evil")' } },
  ];
  const res = await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, { answers });
  expect(res.status).toBe(200);
  return { ...c, short: short!, essay: essay!, mcq: mcq! };
}

describe('marking and results', () => {
  it('shows a marker each answer and completes the result with human marks', async () => {
    const org = await createOrg(h);
    const c = await submitted(org);

    const view = await call(h, 'GET', `/marking/attempts/${c.attemptId}`, org.owner);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ status: 'pending', score: 5, maxScore: 11, needsManual: 2 });
    const essay = view.body.questions.find((q: { id: string }) => q.id === c.essay.id);
    expect(essay).toMatchObject({ auto: false, awarded: null, maxPoints: 4, answer: { text: '=HYPERLINK("http://evil")' } });
    const mcq = view.body.questions.find((q: { id: string }) => q.id === c.mcq.id);
    expect(mcq.options.find((o: { label: string }) => o.label === '4').correct).toBe(true);

    const bad = await call(h, 'PUT', `/marking/attempts/${c.attemptId}`, org.owner, { marks: [{ questionId: c.essay.id, points: 5 }] });
    expect(bad.status).toBe(400);
    const auto = await call(h, 'PUT', `/marking/attempts/${c.attemptId}`, org.owner, { marks: [{ questionId: c.mcq.id, points: 0 }] });
    expect(auto.status).toBe(400);

    const half = await call(h, 'PUT', `/marking/attempts/${c.attemptId}`, org.owner, { marks: [{ questionId: c.short.id, points: 1 }] });
    expect(half.body).toMatchObject({ score: 6, needsManual: 1, status: 'pending' });
    const done = await call(h, 'PUT', `/marking/attempts/${c.attemptId}`, org.owner, {
      marks: [{ questionId: c.essay.id, points: 2.5, comment: 'Thin argument' }],
    });
    expect(done.body).toMatchObject({ score: 8.5, maxScore: 11, needsManual: 0, status: 'marked' });
  });

  it('releases only fully marked results, and candidates see nothing before release', async () => {
    const org = await createOrg(h);
    const a = await submitted(org);
    expect((await call(h, 'GET', '/me/results', a.token)).body.items).toEqual([]);

    const first = await call(h, 'POST', `/sessions/${a.sessionId}/results/release`, org.owner);
    expect(first.body).toEqual({ released: 0, stillPending: 1 });

    await call(h, 'PUT', `/marking/attempts/${a.attemptId}`, org.owner, {
      marks: [
        { questionId: a.short.id, points: 1 },
        { questionId: a.essay.id, points: 4 },
      ],
    });
    const second = await call(h, 'POST', `/sessions/${a.sessionId}/results/release`, org.owner);
    expect(second.body).toEqual({ released: 1, stillPending: 0 });

    const mine = await call(h, 'GET', '/me/results', a.token);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ score: 10, maxScore: 11, percent: 90.9, examName: 'Attempts exam' });

    const locked = await call(h, 'PUT', `/marking/attempts/${a.attemptId}`, org.owner, { marks: [{ questionId: a.essay.id, points: 0 }] });
    expect(locked.status).toBe(409);
    const { rows } = await h.db.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'result_released' AND organisation_id = $1`, [org.id]);
    expect(rows[0].n).toBe(1);
  });

  it('exports results as CSV that a spreadsheet will not run as formulas', async () => {
    const org = await createOrg(h);
    const c = await submitted(org);
    await h.db.query(`UPDATE candidates SET full_name = '=cmd|calc' WHERE id = $1`, [c.candidateId]);
    const res = await h.app.inject({ method: 'GET', url: `/sessions/${c.sessionId}/results?format=csv`, headers: { authorization: `Bearer ${org.owner}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const [header, row] = res.body.trim().split('\r\n');
    expect(header).toBe('Candidate,Student ID,Email,Submitted at,Submitted by,Score,Maximum,Percent,Status,Violations');
    expect(row!.startsWith("'=cmd|calc,")).toBe(true);
    expect(row).toContain(',5,11,45.5,pending,0');
  });

  it('needs the right permission and stays inside the organisation', async () => {
    const org = await createOrg(h);
    const c = await submitted(org);
    const other = await createOrg(h);
    expect((await call(h, 'GET', `/marking/attempts/${c.attemptId}`, other.owner)).status).toBe(404);
    expect((await call(h, 'GET', `/sessions/${c.sessionId}/results`, other.owner)).status).toBe(404);
    expect((await call(h, 'POST', `/sessions/${c.sessionId}/results/release`, other.owner)).status).toBe(404);

    const email = `reviewer-${Date.now()}@${org.slug}.example`;
    await call(h, 'POST', `/organisations/${org.id}/users`, org.owner, { email, displayName: 'Marker', role: 'reviewer', password: PASSWORD });
    const reviewer = (await login(h, org.slug, email)).accessToken;
    expect((await call(h, 'GET', `/marking/attempts/${c.attemptId}`, reviewer)).status).toBe(200);
    expect((await call(h, 'POST', `/sessions/${c.sessionId}/results/release`, reviewer)).status).toBe(403);
    // A candidate cannot mark their own work.
    expect((await call(h, 'GET', `/marking/attempts/${c.attemptId}`, c.token)).status).toBe(403);
  });

  it('refuses to mark an attempt that is still running', async () => {
    const org = await createOrg(h);
    const c = await started(h, org);
    expect((await call(h, 'GET', `/marking/attempts/${c.attemptId}`, org.owner)).status).toBe(409);
  });
});
