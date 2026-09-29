import { expect } from 'vitest';
import { approvedCandidate, call, type Harness, login, minutesFromNow, passingReport, session, type TestOrg, uniq } from './helpers.js';

// Shared by the attempt, live console and results tests.

export interface Q {
  id: string;
  prompt: string;
  options: Record<string, string>; // label -> option id
}

/** Five questions of different types, worth 2 + 3 + 1 + 1 + 4 = 11 marks. */
export async function buildExam(h: Harness, org: TestOrg, security?: object, device?: object) {
  const make = async (body: object) => (await call(h, 'POST', '/questions', org.owner, body)).body.id as string;
  const ids = [
    await make({ type: 'mcq', prompt: 'What is 2 + 2?', options: [{ label: '3' }, { label: '4', isCorrect: true }, { label: '5' }] }),
    await make({
      type: 'multiple_response',
      prompt: 'Pick the primes',
      options: [{ label: '2', isCorrect: true }, { label: '3', isCorrect: true }, { label: '4' }],
    }),
    await make({ type: 'true_false', prompt: 'The sky is blue', options: [{ label: 'True', isCorrect: true }, { label: 'False' }] }),
    await make({ type: 'short_answer', prompt: 'Capital of France?' }),
    await make({ type: 'essay', prompt: 'Discuss.' }),
  ];
  const points = [2, 3, 1, 1, 4];
  const exam = await call(h, 'POST', '/exams', org.owner, {
    code: uniq('EX'),
    name: 'Attempts exam',
    config: { timing: { durationMinutes: 60 }, ...(security ? { security } : {}), ...(device ? { device } : {}) },
  });
  await call(h, 'PUT', `/exams/${exam.body.id}/questions`, org.owner, {
    items: ids.map((questionId, i) => ({ questionId, points: points[i] })),
  });
  const version = await call(h, 'POST', `/exams/${exam.body.id}/publish`, org.owner);
  const pkg = await call(h, 'GET', `/exam-versions/${version.body.id}/package`, org.owner);
  const questions: Q[] = pkg.body.manifest.questions.map((q: { id: string; prompt: string; options: { id: string; label: string }[] }) => ({
    id: q.id,
    prompt: q.prompt,
    options: Object.fromEntries(q.options.map((o) => [o.label, o.id])),
  }));
  return { versionId: version.body.id as string, questions };
}

export async function candidateReady(
  h: Harness,
  org: TestOrg,
  opts: { times?: { startsAt: string; endsAt: string }; precheck?: boolean; exam?: Awaited<ReturnType<typeof buildExam>> } = {},
) {
  const exam = opts.exam ?? (await buildExam(h, org));
  const sessionId = await session(h, org, exam.versionId, opts.times ?? { startsAt: minutesFromNow(-1), endsAt: minutesFromNow(180) });
  const name = uniq('cand');
  const candidateId = await approvedCandidate(h, org, name);
  await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [candidateId] });
  const { accessToken: token } = await login(h, org.slug, `${name}@${org.slug}.example`);
  const assignmentId = (await call(h, 'GET', '/me/entitlements', token)).body.items[0].id as string;
  if (opts.precheck !== false) {
    const res = await call(h, 'POST', `/me/entitlements/${assignmentId}/precheck`, token, passingReport());
    expect(res.body.passed).toBe(true);
  }
  return { ...exam, sessionId, candidateId, token, assignmentId };
}

export async function started(h: Harness, org: TestOrg, security?: object) {
  const c = await candidateReady(h, org, { exam: await buildExam(h, org, security) });
  const res = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId });
  expect(res.status).toBe(201);
  return { ...c, attemptId: res.body.id as string, start: res.body };
}

