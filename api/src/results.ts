import type { Queryable } from './db.js';
import { type AnswerKey, markAttempt, type MarkResult, type PartialCredit, type StoredAnswer } from './marking.js';
import { examConfig } from './examConfig.js';

export interface MarkingInput {
  organisationId: string;
  questions: { id: string; type: string; prompt: string; points: number; options: { id: string; label: string }[] }[];
  answerKey: AnswerKey;
  answers: Map<string, StoredAnswer>;
  manual: Map<string, { points: number; comment: string | null }>;
  partialCredit: PartialCredit;
}

export async function loadMarkingInput(q: Queryable, attemptId: string): Promise<MarkingInput> {
  const { rows } = await q.query<{ organisation_id: string; manifest: { questions: MarkingInput['questions']; config?: unknown }; answer_key: AnswerKey }>(
    `SELECT at.organisation_id, v.manifest, v.answer_key
       FROM attempts at JOIN exam_versions v ON v.id = at.exam_version_id WHERE at.id = $1`,
    [attemptId],
  );
  const row = rows[0]!;
  const { rows: answers } = await q.query<{ question_id: string; response: StoredAnswer }>(
    'SELECT question_id, response FROM answers WHERE attempt_id = $1',
    [attemptId],
  );
  const { rows: manual } = await q.query<{ question_id: string; points: string; comment: string | null }>(
    'SELECT question_id, points, comment FROM manual_marks WHERE attempt_id = $1',
    [attemptId],
  );
  return {
    organisationId: row.organisation_id,
    questions: row.manifest.questions,
    answerKey: row.answer_key,
    answers: new Map(answers.map((a) => [a.question_id, a.response])),
    manual: new Map(manual.map((m) => [m.question_id, { points: Number(m.points), comment: m.comment }])),
    partialCredit: examConfig.parse(row.manifest.config ?? {}).results.partialCredit,
  };
}

export function markFrom(input: MarkingInput): MarkResult {
  return markAttempt(
    input.questions,
    input.answerKey,
    input.answers,
    new Map([...input.manual].map(([id, m]) => [id, m.points])),
    input.partialCredit,
  );
}

/**
 * Recomputes the stored result of a submitted attempt from its answers, the
 * answer key and any human marks. A released result is never changed here.
 */
export async function recomputeResult(q: Queryable, attemptId: string): Promise<MarkResult> {
  const input = await loadMarkingInput(q, attemptId);
  const mark = markFrom(input);
  await q.query(
    `INSERT INTO results (organisation_id, attempt_id, score, max_score, status, marked_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'marked' THEN now() END)
     ON CONFLICT (attempt_id) DO UPDATE
        SET score = EXCLUDED.score, max_score = EXCLUDED.max_score, status = EXCLUDED.status, marked_at = EXCLUDED.marked_at
      WHERE results.status <> 'released'`,
    [input.organisationId, attemptId, mark.score, mark.maxScore, mark.status],
  );
  return mark;
}
