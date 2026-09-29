import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { type Db, type Queryable, type Tx, withTransaction } from './db.js';
import { audit } from './audit.js';
import type { AnswerKey, StoredAnswer } from './marking.js';
import { recomputeResult } from './results.js';
import { expectedStreams, verifySubmission } from './recording.js';
import { enqueueWebhook } from './webhooks.js';
import { canonicalJson, signManifest } from './signing.js';

export type SubmittedBy = 'candidate' | 'timer' | 'system';

export interface Receipt {
  receiptId: string;
  attemptId: string;
  submittedAt: string;
  submittedBy: SubmittedBy;
  answered: number;
  total: number;
  packageSha256: string;
  /** Ed25519 signature over the receipt fields, verifiable with the exam signing key. */
  signature: string;
}

interface AttemptRow {
  id: string;
  organisation_id: string;
  assignment_id: string;
  exam_version_id: string;
  status: string;
  manifest: { questions: { id: string; type: string }[] };
  answer_key: AnswerKey;
}

/** The exact bytes that are signed; a verifier rebuilds this from the receipt fields. */
export function receiptPayload(r: Omit<Receipt, 'signature'>) {
  return { schema: 'examguard.receipt/1', ...r };
}

/**
 * Closes an attempt exactly once: stores the submission, marks what can be
 * marked automatically and moves the entitlement to "submitted". Calling it
 * again returns the original receipt, so retries after a lost response are safe.
 */
export async function finalizeAttempt(
  tx: Tx,
  config: Config,
  attemptId: string,
  by: SubmittedBy,
  actor: { userId: string | null; ip?: string },
): Promise<Receipt> {
  const { rows } = await tx.query<AttemptRow>(
    `SELECT at.id, at.organisation_id, at.assignment_id, at.exam_version_id, at.status,
            v.manifest, v.answer_key
       FROM attempts at JOIN exam_versions v ON v.id = at.exam_version_id
      WHERE at.id = $1 FOR UPDATE OF at`,
    [attemptId],
  );
  const attempt = rows[0]!;

  if (attempt.status !== 'active') return existingReceipt(tx, attemptId);

  const { rows: answerRows } = await tx.query<{ question_id: string; response: StoredAnswer; client_seq: string }>(
    'SELECT question_id, response, client_seq FROM answers WHERE attempt_id = $1 ORDER BY question_id',
    [attemptId],
  );
  const answers = new Map(answerRows.map((a) => [a.question_id, a.response]));
  const total = attempt.manifest.questions.length;

  const packageSha256 = createHash('sha256')
    .update(
      canonicalJson({
        attemptId,
        examVersionId: attempt.exam_version_id,
        answers: answerRows.map((a) => ({ questionId: a.question_id, response: a.response, seq: Number(a.client_seq) })),
      }),
    )
    .digest('hex');

  const { rows: stamped } = await tx.query<{ now: Date }>('SELECT now()');
  const submittedAt = stamped[0]!.now.toISOString();
  const fields = {
    receiptId: randomUUID(),
    attemptId,
    submittedAt,
    submittedBy: by,
    answered: answers.size,
    total,
    packageSha256,
  };
  const signature = signManifest(receiptPayload(fields), config.examSigning.privateKey).signature;

  // An exam that records the candidate is verified only once the recordings
  // have arrived (spec section 12). Without recording there is nothing to wait for.
  const needsEvidence = expectedStreams((attempt.manifest as { config?: unknown }).config).length > 0;
  await tx.query(
    `INSERT INTO submissions (id, organisation_id, attempt_id, package_sha256, status, answered, total, receipt_signature, received_at, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $5 = 'verified' THEN $9::timestamptz END)`,
    [fields.receiptId, attempt.organisation_id, attemptId, packageSha256, needsEvidence ? 'evidence_pending' : 'verified', answers.size, total, signature, submittedAt],
  );
  await tx.query(`UPDATE attempts SET status = 'submitted', submitted_at = $2, submitted_by = $3 WHERE id = $1`, [
    attemptId,
    submittedAt,
    by,
  ]);
  await tx.query(`UPDATE exam_assignments SET status = 'submitted' WHERE id = $1`, [attempt.assignment_id]);

  await recomputeResult(tx, attemptId);
  if (needsEvidence) await verifySubmission(tx, attemptId);

  await tx.query(
    `INSERT INTO events (organisation_id, attempt_id, type, severity, occurred_at, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      attempt.organisation_id,
      attemptId,
      by === 'candidate' ? 'attempt_submitted' : 'attempt_auto_submitted',
      by === 'candidate' ? 'info' : 'warning',
      submittedAt,
      { by, answered: answers.size, total },
    ],
  );
  await enqueueWebhook(tx, attempt.organisation_id, 'attempt.submitted', await submittedPayload(tx, attemptId));
  await audit(tx, {
    organisationId: attempt.organisation_id,
    actorUserId: actor.userId,
    ...(actor.ip ? { ip: actor.ip } : {}),
    action: by === 'candidate' ? 'attempt.submit' : 'attempt.auto_submit',
    targetType: 'attempt',
    targetId: attemptId,
    data: { by, answered: answers.size, total },
  });

  return { ...fields, signature };
}

export async function existingReceipt(q: Queryable, attemptId: string): Promise<Receipt> {
  const { rows } = await q.query<{
    id: string;
    submitted_at: Date;
    submitted_by: SubmittedBy;
    answered: number;
    total: number;
    package_sha256: string;
    receipt_signature: string;
  }>(
    `SELECT s.id, at.submitted_at, at.submitted_by, s.answered, s.total, s.package_sha256, s.receipt_signature
       FROM submissions s JOIN attempts at ON at.id = s.attempt_id
      WHERE s.attempt_id = $1`,
    [attemptId],
  );
  const r = rows[0]!;
  return {
    receiptId: r.id,
    attemptId,
    submittedAt: r.submitted_at.toISOString(),
    submittedBy: r.submitted_by,
    answered: r.answered,
    total: r.total,
    packageSha256: r.package_sha256,
    signature: r.receipt_signature,
  };
}

/**
 * Submits attempts whose deadline (plus grace) has passed, for example when a
 * candidate's device died mid exam. Safe to run on every API instance at once.
 */
export async function finalizeExpiredAttempts(db: Db, config: Config, limit = 50): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM attempts
      WHERE status = 'active' AND deadline_at + make_interval(secs => $1) < now()
      ORDER BY deadline_at LIMIT $2`,
    [config.attemptGraceSeconds, limit],
  );
  let closed = 0;
  for (const { id } of rows) {
    await withTransaction(db, async (tx) => {
      const { rows: still } = await tx.query(
        `SELECT 1 FROM attempts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
        [id],
      );
      if (!still.length) return;
      await finalizeAttempt(tx, config, id, 'timer', { userId: null });
      closed += 1;
    });
  }
  return closed;
}

/** What a webhook receiver learns about a submission. Answers are not included. */
async function submittedPayload(q: Queryable, attemptId: string): Promise<Record<string, unknown>> {
  const { rows } = await q.query(
    `SELECT at.id AS "attemptId", at.submitted_at AS "submittedAt", at.submitted_by AS "submittedBy",
            s.id AS "sessionId", s.name AS "sessionName", v.manifest->>'code' AS "examCode", v.version AS "examVersion",
            json_build_object('id', c.id, 'email', c.email, 'studentId', c.student_id, 'fullName', c.full_name) AS candidate,
            sub.answered, sub.total, sub.id AS "receiptId"
       FROM attempts at
       JOIN exam_assignments a ON a.id = at.assignment_id
       JOIN candidates c ON c.id = a.candidate_id
       JOIN sessions s ON s.id = a.session_id
       JOIN exam_versions v ON v.id = at.exam_version_id
       JOIN submissions sub ON sub.attempt_id = at.id
      WHERE at.id = $1`,
    [attemptId],
  );
  return rows[0] as Record<string, unknown>;
}
