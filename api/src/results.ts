import { type Db, type Queryable, withTransaction } from './db.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import { enqueueWebhook } from './webhooks.js';
import { type AnswerKey, markAttempt, type MarkResult, type PartialCredit, type StoredAnswer } from './marking.js';
import { examConfig } from './examConfig.js';

export interface MarkingInput {
  organisationId: string;
  questions: { id: string; type: string; prompt: string; points: number; options: { id: string; label: string }[] }[];
  answerKey: AnswerKey;
  answers: Map<string, StoredAnswer>;
  manual: Map<string, { points: number; comment: string | null }>;
  partialCredit: PartialCredit;
  autoMark: boolean;
  moderation: boolean;
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
    ...(({ partialCredit, autoMark, moderation }) => ({ partialCredit, autoMark, moderation }))(examConfig.parse(row.manifest.config ?? {}).results),
  };
}

export function markFrom(input: MarkingInput): MarkResult {
  return markAttempt(
    input.questions,
    input.answerKey,
    input.answers,
    new Map([...input.manual].map(([id, m]) => [id, m.points])),
    input.partialCredit,
    input.autoMark,
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
        SET score = EXCLUDED.score, max_score = EXCLUDED.max_score, status = EXCLUDED.status, marked_at = EXCLUDED.marked_at,
            moderated_by = NULL, moderated_at = NULL
      WHERE results.status <> 'released'`,
    [input.organisationId, attemptId, mark.score, mark.maxScore, mark.status],
  );
  return mark;
}

export const percent = (score: number | null, max: number | null) => (score === null || !max ? null : Math.round((score / max) * 1000) / 10);

/**
 * Releases the finished results of a session: marked ones, or only moderated
 * ones when the exam asks for moderation. Each release emails the candidate
 * and sends the organisation's webhook. `releasedBy` is null for a release on
 * the exam's scheduled date. The caller holds the session row lock.
 */
export async function releaseSessionResults(
  tx: Queryable,
  organisationId: string,
  sessionId: string,
  releasedBy: string | null,
): Promise<{ released: number; stillPending: number; awaitingModeration: number }> {
  const { rows: cfg } = await tx.query<{ config: unknown }>(
    `SELECT v.manifest->'config' AS config FROM sessions s JOIN exam_versions v ON v.id = s.exam_version_id WHERE s.id = $1`,
    [sessionId],
  );
  const moderation = examConfig.parse(cfg[0]?.config ?? {}).results.moderation;
  const releasable = moderation ? ['moderated'] : ['marked', 'moderated'];
  const { rows: released } = await tx.query<{ attempt_id: string; user_id: string | null; email: string }>(
    `UPDATE results r SET status = 'released', released_at = now(), released_by = $3
       FROM attempts at JOIN exam_assignments a ON a.id = at.assignment_id JOIN candidates c ON c.id = a.candidate_id
      WHERE r.attempt_id = at.id AND a.session_id = $1 AND r.organisation_id = $2 AND r.status = ANY($4::text[])
      RETURNING r.attempt_id, c.user_id, c.email`,
    [sessionId, organisationId, releasedBy, releasable],
  );
  for (const r of released) {
    const { rows: detail } = await tx.query(
      `SELECT at.id AS "attemptId", r.score::float AS score, r.max_score::float AS "maxScore", r.released_at AS "releasedAt",
              s.id AS "sessionId", s.name AS "sessionName", v.manifest->>'code' AS "examCode", v.version AS "examVersion",
              json_build_object('id', c.id, 'email', c.email, 'studentId', c.student_id, 'fullName', c.full_name) AS candidate
         FROM results r JOIN attempts at ON at.id = r.attempt_id
         JOIN exam_assignments a ON a.id = at.assignment_id JOIN candidates c ON c.id = a.candidate_id
         JOIN sessions s ON s.id = a.session_id JOIN exam_versions v ON v.id = at.exam_version_id
        WHERE r.attempt_id = $1`,
      [r.attempt_id],
    );
    const d = detail[0] as { score: number; maxScore: number };
    await enqueueWebhook(tx, organisationId, 'result.released', { ...d, percent: percent(d.score, d.maxScore) });
    await notify(tx, {
      organisationId,
      kind: 'result_released',
      channel: 'email',
      recipientUserId: r.user_id,
      recipientEmail: r.email,
      payload: { sessionId },
    });
  }
  const { rows: counts } = await tx.query<{ pending: number; marked: number }>(
    `SELECT count(*) FILTER (WHERE r.status = 'pending')::int AS pending, count(*) FILTER (WHERE r.status = 'marked')::int AS marked
       FROM results r JOIN attempts at ON at.id = r.attempt_id
       JOIN exam_assignments a ON a.id = at.assignment_id WHERE a.session_id = $1`,
    [sessionId],
  );
  return { released: released.length, stillPending: counts[0]!.pending, awaitingModeration: moderation ? counts[0]!.marked : 0 };
}

/**
 * Releases results for sessions whose exam set a release date that has now
 * passed. Runs on every instance; the session lock keeps it single. Results
 * marked after the date are released on a later run.
 */
export async function releaseScheduledResults(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: string; organisation_id: string }>(
    `SELECT DISTINCT s.id, s.organisation_id
       FROM sessions s
       JOIN exam_versions v ON v.id = s.exam_version_id
       JOIN exam_assignments a ON a.session_id = s.id
       JOIN attempts at ON at.assignment_id = a.id
       JOIN results r ON r.attempt_id = at.id AND r.status IN ('marked', 'moderated')
      WHERE (v.manifest #>> '{config,results,releaseAt}')::timestamptz <= now()
      LIMIT 100`,
  );
  let total = 0;
  for (const s of rows) {
    total += await withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query('SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE SKIP LOCKED', [s.id]);
      if (!rowCount) return 0;
      const out = await releaseSessionResults(tx, s.organisation_id, s.id, null);
      if (out.released) {
        await audit(tx, {
          organisationId: s.organisation_id,
          actorUserId: null,
          action: 'results.release',
          targetType: 'session',
          targetId: s.id,
          data: { ...out, scheduled: true },
        });
      }
      return out.released;
    });
  }
  return total;
}
