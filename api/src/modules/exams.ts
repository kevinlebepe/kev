import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { isUniqueViolation, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { authorize, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { examConfig, type ExamConfig } from '../examConfig.js';
import { signManifest } from '../signing.js';
import { idParams, page, pagination, parse } from '../validation.js';

const createExamBody = z.object({
  code: z.string().regex(/^[A-Za-z0-9._-]{1,50}$/),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).default(''),
  subject: z.string().max(200).optional(),
  config: examConfig.default(examConfig.parse({})),
});

const updateExamBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  subject: z.string().max(200).nullable().optional(),
  config: examConfig.optional(),
});

const questionBody = z
  .object({
    type: z.enum(['mcq', 'multiple_response', 'true_false', 'short_answer', 'essay', 'file_upload']),
    prompt: z.string().min(1).max(20000),
    category: z.string().max(200).optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    options: z
      .array(z.object({ label: z.string().min(1).max(2000), isCorrect: z.boolean().default(false) }))
      .max(26)
      .default([]),
  })
  .superRefine((q, ctx) => {
    const correct = q.options.filter((o) => o.isCorrect).length;
    const choice = q.type === 'mcq' || q.type === 'multiple_response' || q.type === 'true_false';
    if (choice && q.options.length < 2) ctx.addIssue({ code: 'custom', message: 'At least two options required' });
    if (!choice && q.options.length) ctx.addIssue({ code: 'custom', message: `${q.type} questions take no options` });
    if ((q.type === 'mcq' || q.type === 'true_false') && correct !== 1)
      ctx.addIssue({ code: 'custom', message: 'Exactly one option must be correct' });
    if (q.type === 'multiple_response' && correct < 1)
      ctx.addIssue({ code: 'custom', message: 'At least one option must be correct' });
  });

const setQuestionsBody = z.object({
  items: z
    .array(z.object({ questionId: z.uuid(), points: z.number().min(0).max(1000).default(1) }))
    .max(1000)
    .refine((items) => new Set(items.map((i) => i.questionId)).size === items.length, 'Duplicate question'),
});

const setPoolsBody = z.object({
  pools: z
    .array(
      z.object({
        category: z.string().trim().max(200).nullable().optional(),
        difficulty: z.enum(['easy', 'medium', 'hard']).nullable().optional(),
        draw: z.number().int().min(1).max(200),
        points: z.number().min(0).max(1000).default(1),
      }),
    )
    .max(20),
});

interface ManifestQuestion {
  id: string;
  type: string;
  prompt: string;
  points: number;
  options: { id: string; label: string }[];
}

/** Which bank questions a pool may draw from: its category and difficulty, when set. */
const POOL_MATCH = `(p.category IS NULL OR lower(q.category) = lower(p.category)) AND (p.difficulty IS NULL OR q.difficulty = p.difficulty)`;

export async function examRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;

  // Candidate devices use this key to verify exam packages before starting (spec section 6).
  app.get('/exam-signing-key', async () => ({
    keyId: config.examSigning.keyId,
    algorithm: 'Ed25519',
    publicKeyPem: config.examSigning.publicKey.export({ type: 'spki', format: 'pem' }),
  }));

  app.post('/exams', { preHandler: authorize('exam:create') }, async (req, reply) => {
    const auth = requireOrg(req);
    const body = parse(createExamBody, req.body);
    const exam = await withTransaction(db, async (tx) => {
      const { rows } = await tx
        .query<{ id: string }>(
          `INSERT INTO exams (organisation_id, code, name, description, subject, config, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [auth.organisationId, body.code, body.name, body.description, body.subject ?? null, body.config, auth.userId],
        )
        .catch((err) => {
          if (isUniqueViolation(err)) throw conflict('An exam with this code already exists');
          throw err;
        });
      const id = rows[0]!.id;
      await audit(tx, { ...auditFrom(req), action: 'exam.create', targetType: 'exam', targetId: id, data: { code: body.code } });
      return { id, status: 'draft' };
    });
    return reply.code(201).send(exam);
  });

  app.get('/exams', { preHandler: authorize('exam:create') }, async (req) => {
    const auth = requireOrg(req);
    const { limit, offset } = parse(pagination, req.query);
    const { rows } = await db.query(
      `SELECT e.id, e.code, e.name, e.status, e.updated_at AS "updatedAt",
              (SELECT max(version) FROM exam_versions v WHERE v.exam_id = e.id) AS "latestVersion"
         FROM exams e WHERE e.organisation_id = $1
        ORDER BY e.created_at DESC, e.id LIMIT $2 OFFSET $3`,
      [auth.organisationId, limit, offset],
    );
    return page(rows, limit, offset);
  });

  app.get('/exams/:id', { preHandler: authorize('exam:create') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query(
      `SELECT id, code, name, description, subject, status, config, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM exams WHERE id = $1 AND organisation_id = $2`,
      [id, auth.organisationId],
    );
    if (!rows[0]) throw notFound('Exam');
    const { rows: questions } = await db.query(
      `SELECT q.id, q.type, q.prompt, eq.position, eq.points::float AS points
         FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
        WHERE eq.exam_id = $1 ORDER BY eq.position`,
      [id],
    );
    const { rows: versions } = await db.query(
      `SELECT id, version, manifest_sha256 AS "manifestSha256", published_at AS "publishedAt"
         FROM exam_versions WHERE exam_id = $1 ORDER BY version`,
      [id],
    );
    const { rows: pools } = await db.query(
      `SELECT p.id, p.category, p.difficulty, p.draw_count AS draw, p.points::float AS points,
              (SELECT count(*)::int FROM questions q
                WHERE q.organisation_id = $2 AND ${POOL_MATCH}
                  AND q.id NOT IN (SELECT question_id FROM exam_questions WHERE exam_id = p.exam_id)) AS available
         FROM exam_pools p WHERE p.exam_id = $1 ORDER BY p.position`,
      [id, auth.organisationId],
    );
    return { ...rows[0], questions, pools, versions };
  });

  // Edits only ever touch the draft. Published versions are separate immutable
  // rows, so changing the draft can never alter an exam candidates are sitting.
  app.patch('/exams/:id', { preHandler: authorize('exam:create') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const body = parse(updateExamBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE exams SET
            name = coalesce($3, name),
            description = coalesce($4, description),
            subject = CASE WHEN $5::boolean THEN $6 ELSE subject END,
            config = coalesce($7, config),
            updated_at = now()
          WHERE id = $1 AND organisation_id = $2 AND status <> 'archived'
          RETURNING id, code, name, description, subject, status, config`,
        [
          id,
          auth.organisationId,
          body.name ?? null,
          body.description ?? null,
          body.subject !== undefined,
          body.subject ?? null,
          body.config ?? null,
        ],
      );
      if (!rows[0]) throw notFound('Exam');
      await audit(tx, { ...auditFrom(req), action: 'exam.update', targetType: 'exam', targetId: id });
      return rows[0];
    });
  });

  app.post('/questions', { preHandler: authorize('exam:create') }, async (req, reply) => {
    const auth = requireOrg(req);
    const body = parse(questionBody, req.body);
    const id = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO questions (organisation_id, type, prompt, category, difficulty)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [auth.organisationId, body.type, body.prompt, body.category ?? null, body.difficulty ?? null],
      );
      const questionId = rows[0]!.id;
      for (const [position, option] of body.options.entries()) {
        await tx.query('INSERT INTO question_options (question_id, position, label, is_correct) VALUES ($1, $2, $3, $4)', [
          questionId,
          position,
          option.label,
          option.isCorrect,
        ]);
      }
      await audit(tx, { ...auditFrom(req), action: 'question.create', targetType: 'question', targetId: questionId });
      return questionId;
    });
    return reply.code(201).send({ id });
  });

  app.get('/questions', { preHandler: authorize('exam:create') }, async (req) => {
    const auth = requireOrg(req);
    const { limit, offset } = parse(pagination, req.query);
    const { rows } = await db.query(
      `SELECT id, type, prompt, category, difficulty FROM questions
        WHERE organisation_id = $1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
      [auth.organisationId, limit, offset],
    );
    return page(rows, limit, offset);
  });

  app.put('/exams/:id/questions', { preHandler: authorize('exam:create') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { items } = parse(setQuestionsBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query(
        `SELECT 1 FROM exams WHERE id = $1 AND organisation_id = $2 AND status <> 'archived' FOR UPDATE`,
        [id, auth.organisationId],
      );
      if (!rowCount) throw notFound('Exam');

      // Every question must belong to the same organisation (tenant isolation).
      const ids = items.map((i) => i.questionId);
      const { rows: owned } = await tx.query<{ id: string }>(
        'SELECT id FROM questions WHERE organisation_id = $1 AND id = ANY($2::uuid[])',
        [auth.organisationId, ids],
      );
      if (owned.length !== ids.length) throw badRequest('One or more questions were not found');

      await tx.query('DELETE FROM exam_questions WHERE exam_id = $1', [id]);
      for (const [position, item] of items.entries()) {
        await tx.query('INSERT INTO exam_questions (exam_id, question_id, position, points) VALUES ($1, $2, $3, $4)', [
          id,
          item.questionId,
          position,
          item.points,
        ]);
      }
      await tx.query('UPDATE exams SET updated_at = now() WHERE id = $1', [id]);
      await audit(tx, { ...auditFrom(req), action: 'exam.set_questions', targetType: 'exam', targetId: id, data: { count: items.length } });
      return { examId: id, count: items.length };
    });
  });

  // Random draws from the question bank (spec section 6).
  app.put('/exams/:id/pools', { preHandler: authorize('exam:create') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { pools } = parse(setPoolsBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query(
        `SELECT 1 FROM exams WHERE id = $1 AND organisation_id = $2 AND status <> 'archived' FOR UPDATE`,
        [id, auth.organisationId],
      );
      if (!rowCount) throw notFound('Exam');
      await tx.query('DELETE FROM exam_pools WHERE exam_id = $1', [id]);
      for (const [position, p] of pools.entries()) {
        await tx.query(`INSERT INTO exam_pools (exam_id, position, category, difficulty, draw_count, points) VALUES ($1, $2, $3, $4, $5, $6)`, [
          id,
          position,
          p.category || null,
          p.difficulty ?? null,
          p.draw,
          p.points,
        ]);
      }
      await tx.query('UPDATE exams SET updated_at = now() WHERE id = $1', [id]);
      await audit(tx, { ...auditFrom(req), action: 'exam.set_pools', targetType: 'exam', targetId: id, data: { pools } });
      return { examId: id, count: pools.length };
    });
  });

  app.post('/exams/:id/publish', { preHandler: authorize('exam:publish') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);

    const version = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ code: string; name: string; description: string; status: string; config: ExamConfig }>(
        'SELECT code, name, description, status, config FROM exams WHERE id = $1 AND organisation_id = $2 FOR UPDATE',
        [id, auth.organisationId],
      );
      const exam = rows[0];
      if (!exam) throw notFound('Exam');
      if (exam.status === 'archived') throw conflict('Archived exams cannot be published');

      // Re-validate stored config: it may predate current rules.
      const configResult = examConfig.safeParse(exam.config);
      const problems: string[] = [];
      if (!configResult.success) problems.push('Exam configuration is invalid');
      else if (!configResult.data.timing.durationMinutes) problems.push('Duration is required');

      const { rows: qs } = await tx.query<{
        id: string;
        type: string;
        prompt: string;
        points: number;
        options: { id: string; label: string; isCorrect: boolean }[];
      }>(
        `SELECT q.id, q.type, q.prompt, eq.points::float AS points,
                coalesce(json_agg(json_build_object('id', o.id, 'label', o.label, 'isCorrect', o.is_correct)
                         ORDER BY o.position) FILTER (WHERE o.id IS NOT NULL), '[]') AS options
           FROM exam_questions eq
           JOIN questions q ON q.id = eq.question_id
           LEFT JOIN question_options o ON o.question_id = q.id
          WHERE eq.exam_id = $1
          GROUP BY q.id, eq.position, eq.points
          ORDER BY eq.position`,
        [id],
      );
      // Each pool takes the bank questions that match it, leaving out the
      // exam's fixed questions and any an earlier pool already took.
      const { rows: poolRows } = await tx.query<{ id: string; category: string | null; difficulty: string | null; draw: number; points: number }>(
        `SELECT id, category, difficulty, draw_count AS draw, points::float AS points FROM exam_pools p WHERE exam_id = $1 ORDER BY position`,
        [id],
      );
      const taken = new Set(qs.map((q) => q.id));
      const pools: { id: string; draw: number; questionIds: string[] }[] = [];
      for (const [n, p] of poolRows.entries()) {
        const { rows: members } = await tx.query<(typeof qs)[number]>(
          `SELECT q.id, q.type, q.prompt, $3::float AS points,
                  coalesce(json_agg(json_build_object('id', o.id, 'label', o.label, 'isCorrect', o.is_correct)
                           ORDER BY o.position) FILTER (WHERE o.id IS NOT NULL), '[]') AS options
             FROM exam_pools p
             JOIN questions q ON q.organisation_id = $2 AND ${POOL_MATCH}
             LEFT JOIN question_options o ON o.question_id = q.id
            WHERE p.id = $1
            GROUP BY q.id
            ORDER BY q.created_at, q.id`,
          [p.id, auth.organisationId, p.points],
        );
        const fresh = members.filter((m) => !taken.has(m.id));
        if (fresh.length < p.draw) {
          const what = [p.category && `category ${p.category}`, p.difficulty && `${p.difficulty} difficulty`].filter(Boolean).join(', ') || 'any question';
          problems.push(`Pool ${n + 1} (${what}) needs ${p.draw} questions but the bank has ${fresh.length}`);
          continue;
        }
        for (const m of fresh) {
          taken.add(m.id);
          qs.push(m);
        }
        pools.push({ id: p.id, draw: p.draw, questionIds: fresh.map((m) => m.id) });
      }
      if (qs.length === 0) problems.push('At least one question is required');
      if (problems.length) throw badRequest('Exam is not ready to publish', problems);

      const { rows: last } = await tx.query<{ max: number | null }>(
        'SELECT max(version) AS max FROM exam_versions WHERE exam_id = $1',
        [id],
      );
      const nextVersion = (last[0]?.max ?? 0) + 1;

      const questions: ManifestQuestion[] = qs.map((q) => ({
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        points: q.points,
        options: q.options.map((o) => ({ id: o.id, label: o.label })),
      }));
      const manifest = {
        schema: 'examguard.exam-manifest/1',
        organisationId: auth.organisationId,
        examId: id,
        version: nextVersion,
        code: exam.code,
        name: exam.name,
        description: exam.description,
        config: configResult.data,
        questions,
        // Each candidate gets `draw` of each pool's questions, chosen when they start.
        ...(pools.length ? { pools } : {}),
      };
      // Correct answers stay server-side; the client is never trusted with them.
      const answerKey = Object.fromEntries(
        qs.map((q) => [q.id, { points: q.points, correctOptionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id) }]),
      );
      const signed = signManifest(manifest, config.examSigning.privateKey);

      const { rows: inserted } = await tx.query<{ id: string }>(
        `INSERT INTO exam_versions
           (organisation_id, exam_id, version, manifest, manifest_sha256, signature, signing_key_id, answer_key, published_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          auth.organisationId,
          id,
          nextVersion,
          manifest,
          signed.sha256,
          signed.signature,
          config.examSigning.keyId,
          answerKey,
          auth.userId,
        ],
      );
      await tx.query(`UPDATE exams SET status = 'published', updated_at = now() WHERE id = $1`, [id]);
      await audit(tx, {
        ...auditFrom(req),
        action: 'exam.publish',
        targetType: 'exam',
        targetId: id,
        data: { version: nextVersion, manifestSha256: signed.sha256 },
      });
      return { id: inserted[0]!.id, examId: id, version: nextVersion, manifestSha256: signed.sha256 };
    });
    return reply.code(201).send(version);
  });

  // Published versions a session can be created for, newest first.
  app.get('/exam-versions', { preHandler: authorize('session:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { limit, offset } = parse(pagination, req.query);
    const { rows } = await db.query(
      `SELECT v.id, v.exam_id AS "examId", v.version, v.published_at AS "publishedAt",
              v.manifest->>'code' AS code, v.manifest->>'name' AS name,
              (v.manifest#>>'{config,timing,durationMinutes}')::int AS "durationMinutes"
         FROM exam_versions v JOIN exams e ON e.id = v.exam_id
        WHERE v.organisation_id = $1 AND e.status <> 'archived'
        ORDER BY v.published_at DESC, v.id LIMIT $2 OFFSET $3`,
      [auth.organisationId, limit, offset],
    );
    return page(rows, limit, offset);
  });

  // Signed package for staff preview; candidate delivery (with entitlement checks) is MVP-2.
  app.get('/exam-versions/:id/package', { preHandler: authorize('exam:create') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query(
      `SELECT manifest, manifest_sha256 AS "manifestSha256", signature, signing_key_id AS "keyId"
         FROM exam_versions WHERE id = $1 AND organisation_id = $2`,
      [id, auth.organisationId],
    );
    if (!rows[0]) throw notFound('Exam version');
    return rows[0];
  });
}
