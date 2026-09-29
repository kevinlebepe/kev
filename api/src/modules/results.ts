import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { authorize, requireCandidate, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { notify } from '../notifications.js';
import { AUTO_MARKED } from '../marking.js';
import { loadMarkingInput, markFrom, recomputeResult } from '../results.js';
import { COUNTED_EVENT_TYPES } from '../rules.js';
import { idParams, parse } from '../validation.js';
import { enqueueWebhook } from '../webhooks.js';

const marksBody = z.object({
  marks: z
    .array(z.object({ questionId: z.uuid(), points: z.number().min(0).max(1000), comment: z.string().max(2000).optional() }))
    .min(1)
    .max(500),
});

const resultsQuery = z.object({ format: z.enum(['json', 'csv']).default('json') });

/** Spreadsheet programs run cells that start with these characters as formulas. */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const percent = (score: number | null, max: number | null) => (score === null || !max ? null : Math.round((score / max) * 1000) / 10);

export async function resultRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  // Every submitted attempt in a session, with where its marking stands.
  app.get('/sessions/:id/results', { preHandler: authorize('report:view') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { format } = parse(resultsQuery, req.query);
    const { rows: session } = await db.query<{ name: string }>('SELECT name FROM sessions WHERE id = $1 AND organisation_id = $2', [
      id,
      auth.organisationId,
    ]);
    if (!session[0]) throw notFound('Session');
    const { rows } = await db.query<{
      attemptId: string;
      candidateId: string;
      fullName: string;
      studentId: string | null;
      email: string;
      submittedAt: Date;
      submittedBy: string;
      score: number | null;
      maxScore: number | null;
      status: string;
      releasedAt: Date | null;
      violations: number;
    }>(
      `SELECT at.id AS "attemptId", c.id AS "candidateId", c.full_name AS "fullName", c.student_id AS "studentId", c.email,
              at.submitted_at AS "submittedAt", at.submitted_by AS "submittedBy",
              r.score::float AS score, r.max_score::float AS "maxScore", r.status, r.released_at AS "releasedAt",
              (SELECT count(*)::int FROM events e WHERE e.attempt_id = at.id AND e.type = ANY($3::text[])) AS violations
         FROM attempts at
         JOIN exam_assignments a ON a.id = at.assignment_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN results r ON r.attempt_id = at.id
        WHERE a.session_id = $1 AND at.organisation_id = $2
        ORDER BY c.full_name, c.id`,
      [id, auth.organisationId, COUNTED_EVENT_TYPES],
    );
    const items = rows.map((r) => ({ ...r, percent: percent(r.score, r.maxScore) }));
    const summary = {
      submitted: items.length,
      pending: items.filter((r) => r.status === 'pending').length,
      marked: items.filter((r) => r.status === 'marked').length,
      released: items.filter((r) => r.status === 'released').length,
    };

    if (format === 'csv') {
      const header = ['Candidate', 'Student ID', 'Email', 'Submitted at', 'Submitted by', 'Score', 'Maximum', 'Percent', 'Status', 'Violations'];
      const lines = items.map((r) =>
        [r.fullName, r.studentId, r.email, r.submittedAt.toISOString(), r.submittedBy, r.score, r.maxScore, r.percent, r.status, r.violations]
          .map(csvCell)
          .join(','),
      );
      const name = session[0].name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'session';
      await withTransaction(db, (tx) => audit(tx, { ...auditFrom(req), action: 'results.export', targetType: 'session', targetId: id }));
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}-results.csv"`)
        .send([header.join(','), ...lines].join('\r\n') + '\r\n');
    }
    return { sessionId: id, summary, items };
  });

  // What a marker sees: each question, the answer given, and the marks so far.
  app.get('/marking/attempts/:id', { preHandler: authorize('result:mark') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query<{ status: string; result_status: string | null; full_name: string; student_id: string | null; session_id: string; session_name: string; exam_name: string }>(
      `SELECT at.status, r.status AS result_status, c.full_name, c.student_id, s.id AS session_id, s.name AS session_name, v.manifest->>'name' AS exam_name
         FROM attempts at
         JOIN exam_assignments a ON a.id = at.assignment_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN sessions s ON s.id = a.session_id
         JOIN exam_versions v ON v.id = at.exam_version_id
         LEFT JOIN results r ON r.attempt_id = at.id
        WHERE at.id = $1 AND at.organisation_id = $2`,
      [id, auth.organisationId],
    );
    const row = rows[0];
    if (!row) throw notFound('Attempt');
    if (row.status === 'active') throw conflict('This attempt is still in progress');

    const input = await loadMarkingInput(db, id);
    const mark = markFrom(input);
    const byId = new Map(mark.questions.map((q) => [q.questionId, q]));
    return {
      attemptId: id,
      candidate: { fullName: row.full_name, studentId: row.student_id },
      sessionId: row.session_id,
      sessionName: row.session_name,
      examName: row.exam_name,
      status: row.result_status ?? 'pending',
      score: mark.score,
      maxScore: mark.maxScore,
      needsManual: mark.needsManual,
      questions: input.questions.map((q) => {
        const m = byId.get(q.id);
        const key = input.answerKey[q.id];
        return {
          id: q.id,
          type: q.type,
          prompt: q.prompt,
          options: q.options.map((o) => ({ ...o, correct: key?.correctOptionIds.includes(o.id) ?? false })),
          answer: input.answers.get(q.id) ?? null,
          maxPoints: m?.maxPoints ?? q.points,
          awarded: m?.awarded ?? null,
          auto: AUTO_MARKED.has(q.type),
          comment: input.manual.get(q.id)?.comment ?? null,
        };
      }),
    };
  });

  // Human marks for free text answers. Choice questions are always marked from the key.
  app.put('/marking/attempts/:id', { preHandler: authorize('result:mark') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { marks } = parse(marksBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ status: string; result_status: string | null }>(
        `SELECT at.status, r.status AS result_status FROM attempts at LEFT JOIN results r ON r.attempt_id = at.id
          WHERE at.id = $1 AND at.organisation_id = $2 FOR UPDATE OF at`,
        [id, auth.organisationId],
      );
      if (!rows[0]) throw notFound('Attempt');
      if (rows[0].status === 'active') throw conflict('This attempt is still in progress');
      if (rows[0].result_status === 'released') throw conflict('This result has been released and can no longer be changed');

      const input = await loadMarkingInput(tx, id);
      const questions = new Map(input.questions.map((q) => [q.id, q]));
      for (const m of marks) {
        const q = questions.get(m.questionId);
        if (!q) throw badRequest(`Question ${m.questionId} is not part of this exam`);
        if (AUTO_MARKED.has(q.type)) throw badRequest(`Question ${m.questionId} is marked automatically`);
        const max = input.answerKey[q.id]?.points ?? 0;
        if (m.points > max) throw badRequest(`Question ${m.questionId} is worth at most ${max}`);
        await tx.query(
          `INSERT INTO manual_marks (attempt_id, question_id, points, comment, marked_by) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (attempt_id, question_id) DO UPDATE
              SET points = EXCLUDED.points, comment = EXCLUDED.comment, marked_by = EXCLUDED.marked_by, marked_at = now()`,
          [id, m.questionId, m.points, m.comment ?? null, auth.userId],
        );
      }
      const mark = await recomputeResult(tx, id);
      await audit(tx, { ...auditFrom(req), action: 'result.mark', targetType: 'attempt', targetId: id, data: { marks } });
      return { score: mark.score, maxScore: mark.maxScore, needsManual: mark.needsManual, status: mark.status };
    });
  });

  // Releases every fully marked result in a session. Results still waiting for a marker stay unreleased.
  app.post('/sessions/:id/results/release', { preHandler: authorize('result:release') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query('SELECT 1 FROM sessions WHERE id = $1 AND organisation_id = $2 FOR UPDATE', [
        id,
        auth.organisationId,
      ]);
      if (!rowCount) throw notFound('Session');
      const { rows: released } = await tx.query<{ attempt_id: string; user_id: string | null; email: string }>(
        `UPDATE results r SET status = 'released', released_at = now(), released_by = $3
           FROM attempts at JOIN exam_assignments a ON a.id = at.assignment_id JOIN candidates c ON c.id = a.candidate_id
          WHERE r.attempt_id = at.id AND a.session_id = $1 AND r.organisation_id = $2 AND r.status IN ('marked', 'moderated')
          RETURNING r.attempt_id, c.user_id, c.email`,
        [id, auth.organisationId, auth.userId],
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
        await enqueueWebhook(tx, auth.organisationId, 'result.released', { ...d, percent: percent(d.score, d.maxScore) });
        await notify(tx, {
          organisationId: auth.organisationId,
          kind: 'result_released',
          channel: 'email',
          recipientUserId: r.user_id,
          recipientEmail: r.email,
          payload: { sessionId: id },
        });
      }
      const { rows: pending } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM results r JOIN attempts at ON at.id = r.attempt_id
           JOIN exam_assignments a ON a.id = at.assignment_id WHERE a.session_id = $1 AND r.status = 'pending'`,
        [id],
      );
      await audit(tx, {
        ...auditFrom(req),
        action: 'results.release',
        targetType: 'session',
        targetId: id,
        data: { released: released.length, pending: pending[0]!.n },
      });
      return { released: released.length, stillPending: pending[0]!.n };
    });
  });

  // A candidate's released results. Nothing is shown before release.
  app.get('/me/results', async (req) => {
    const auth = requireCandidate(req);
    const { rows } = await db.query<{ score: number; maxScore: number } & Record<string, unknown>>(
      `SELECT a.id AS "entitlementId", s.name AS "sessionName", v.manifest->>'name' AS "examName", v.manifest->>'code' AS "examCode",
              r.score::float AS score, r.max_score::float AS "maxScore", r.released_at AS "releasedAt", at.submitted_at AS "submittedAt"
         FROM results r
         JOIN attempts at ON at.id = r.attempt_id
         JOIN exam_assignments a ON a.id = at.assignment_id
         JOIN sessions s ON s.id = a.session_id
         JOIN exam_versions v ON v.id = at.exam_version_id
        WHERE a.candidate_id = $1 AND r.organisation_id = $2 AND r.status = 'released'
        ORDER BY r.released_at DESC`,
      [auth.candidateId, auth.organisationId],
    );
    return { items: rows.map((r) => ({ ...r, percent: percent(r.score, r.maxScore) })) };
  });
}
