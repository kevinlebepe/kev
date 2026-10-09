import { describe, expect, it } from 'vitest';
import { drawQuestions } from '../src/modules/attempts.js';
import { approvedCandidate, call, createOrg, login, minutesFromNow, passingReport, session, type TestOrg, uniq, useHarness } from './helpers.js';

const h = useHarness();

/** A bank of choice questions in one category, each worth 1 with the first option correct. */
async function bank(org: TestOrg, category: string, n: number, difficulty?: string) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const q = await call(h, 'POST', '/questions', org.owner, {
      type: 'mcq',
      prompt: `${category} ${i}`,
      category,
      ...(difficulty ? { difficulty } : {}),
      options: [{ label: 'right', isCorrect: true }, { label: 'wrong' }],
    });
    ids.push(q.body.id);
  }
  return ids;
}

async function candidateFor(org: TestOrg, versionId: string) {
  const sessionId = await session(h, org, versionId, { startsAt: minutesFromNow(-1), endsAt: minutesFromNow(120) });
  const name = uniq('cand');
  await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [await approvedCandidate(h, org, name)] });
  const token = (await login(h, org.slug, `${name}@${org.slug}.example`)).accessToken;
  const assignmentId = (await call(h, 'GET', '/me/entitlements', token)).body.items[0].id as string;
  await call(h, 'POST', `/me/entitlements/${assignmentId}/precheck`, token, passingReport());
  const start = await call(h, 'POST', '/attempts/start', token, { assignmentId });
  expect(start.status).toBe(201);
  return { token, attemptId: start.body.id as string, order: start.body.questionOrder as string[] };
}

describe('drawing questions', () => {
  it('keeps fixed questions and takes the right number from each pool', () => {
    const pools = [{ draw: 2, questionIds: ['p1', 'p2', 'p3', 'p4'] }];
    for (let i = 0; i < 20; i++) {
      const got = drawQuestions(['f1', 'f2', 'p1', 'p2', 'p3', 'p4'], pools, false)!;
      expect(got.slice(0, 2)).toEqual(['f1', 'f2']);
      expect(got).toHaveLength(4);
      expect(new Set(got).size).toBe(4);
    }
    expect(drawQuestions(['a', 'b'], null, false)).toBeNull();
  });
});

describe('question pools', () => {
  it('publishes every matching question and gives each candidate their own draw', async () => {
    const org = await createOrg(h);
    const algebra = await bank(org, 'Algebra', 5, 'easy');
    await bank(org, 'Algebra', 2, 'hard');
    await bank(org, 'Geometry', 3);
    const fixed = await call(h, 'POST', '/questions', org.owner, { type: 'essay', prompt: 'Explain your method.' });
    const exam = await call(h, 'POST', '/exams', org.owner, { code: uniq('P'), name: 'Pooled exam', config: { timing: { durationMinutes: 30 } } });
    await call(h, 'PUT', `/exams/${exam.body.id}/questions`, org.owner, { items: [{ questionId: fixed.body.id, points: 4 }] });

    // Asking for more than the bank holds stops publishing, with a reason.
    await call(h, 'PUT', `/exams/${exam.body.id}/pools`, org.owner, { pools: [{ category: 'algebra', difficulty: 'easy', draw: 6, points: 2 }] });
    const refused = await call(h, 'POST', `/exams/${exam.body.id}/publish`, org.owner);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('needs 6 questions but the bank has 5');

    await call(h, 'PUT', `/exams/${exam.body.id}/pools`, org.owner, {
      pools: [
        { category: 'algebra', difficulty: 'easy', draw: 3, points: 2 },
        { category: 'Geometry', draw: 1, points: 1 },
      ],
    });
    const detail = await call(h, 'GET', `/exams/${exam.body.id}`, org.owner);
    expect(detail.body.pools).toMatchObject([
      { category: 'algebra', difficulty: 'easy', draw: 3, available: 5 },
      { category: 'Geometry', draw: 1, available: 3 },
    ]);
    const version = await call(h, 'POST', `/exams/${exam.body.id}/publish`, org.owner);
    expect(version.status).toBe(201);
    const pkg = await call(h, 'GET', `/exam-versions/${version.body.id}/package`, org.owner);
    expect(pkg.body.manifest.questions).toHaveLength(1 + 5 + 3);
    expect(pkg.body.manifest.pools.map((p: { draw: number }) => p.draw)).toEqual([3, 1]);

    const first = await candidateFor(org, version.body.id);
    expect(first.order).toHaveLength(1 + 3 + 1);
    expect(first.order[0]).toBe(fixed.body.id);
    expect(first.order.filter((id) => algebra.includes(id))).toHaveLength(3);

    // An answer to a question this candidate was not given is refused.
    const notGiven = algebra.find((id) => !first.order.includes(id))!;
    const bad = await call(h, 'PATCH', `/attempts/${first.attemptId}/state`, first.token, { answers: [{ questionId: notGiven, seq: 1, response: { optionId: pkg.body.manifest.questions.find((q: { id: string }) => q.id === notGiven).options[0].id } }] });
    expect(bad.status).toBe(400);

    // Marking counts only the drawn questions: 4 + 3 x 2 + 1 = 11.
    const answers = first.order
      .filter((id) => id !== fixed.body.id)
      .map((id) => ({ questionId: id, seq: 1, response: { optionId: pkg.body.manifest.questions.find((q: { id: string }) => q.id === id).options[0].id } }));
    const receipt = (await call(h, 'POST', `/attempts/${first.attemptId}/submit`, first.token, { answers })).body.receipt;
    expect(receipt).toMatchObject({ answered: 4, total: 5 });
    const marking = await call(h, 'GET', `/marking/attempts/${first.attemptId}`, org.owner);
    expect(marking.body).toMatchObject({ maxScore: 11, score: 7 });
    expect(marking.body.questions).toHaveLength(5);

    // Draws differ between candidates (the chance of five identical draws is tiny).
    const draws = new Set([first.order.join()]);
    for (let i = 0; i < 4; i++) draws.add((await candidateFor(org, version.body.id)).order.join());
    expect(draws.size).toBeGreaterThan(1);
  });
});
