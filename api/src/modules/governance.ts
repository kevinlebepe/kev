import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { type Queryable, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { authorize, requireAuth, requireCandidate, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { notify } from '../notifications.js';
import { notifyStaff } from '../alerts.js';
import { idParams, parse } from '../validation.js';

// Privacy and governance (spec sections 2, 19 and 23): holding an attempt's
// evidence for an appeal, exporting and erasing a candidate's data, and
// support cases that keep an organisation's questions apart from platform
// problems.

const holdBody = z.object({ reason: z.string().trim().min(3).max(500) });
const eraseBody = z.object({ confirmEmail: z.string().trim().min(3).max(320) });

const CATEGORIES = ['sign_in', 'device_check', 'exam_access', 'accommodation', 'during_exam', 'results', 'other'] as const;
/** Questions about rules, eligibility and accommodations go to the organisation; the rest start with platform support. */
const PLATFORM_CATEGORIES = new Set(['sign_in', 'device_check', 'during_exam']);
const caseBody = z.object({
  category: z.enum(CATEGORIES),
  summary: z.string().trim().min(3).max(200),
  details: z.string().trim().max(5000).optional(),
  entitlementId: z.uuid().optional(),
});
const caseUpdate = z.object({
  status: z.enum(['open', 'in_progress', 'resolved']).optional(),
  reply: z.string().trim().min(1).max(5000).optional(),
  /** Hand a case between the organisation and platform support. */
  scope: z.enum(['organisation', 'platform']).optional(),
});
const caseList = z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'all']).default('all'), limit: z.coerce.number().int().min(1).max(200).default(100) });
/** A candidate may have at most this many unresolved cases, which keeps the form from being used to flood staff. */
const MAX_OPEN_CASES = 10;

/**
 * Everything the organisation holds about one candidate, as data (spec
 * section 19, data export). Recordings and files are listed, not included.
 * `released` limits results to those already released, for the candidate's
 * own copy.
 */
async function candidateData(q: Queryable, organisationId: string, candidateId: string, opts: { released: boolean }) {
  const { rows: profile } = await q.query(
    `SELECT id, email, full_name AS "fullName", student_id AS "studentId", programme, status, identity_status AS "identityStatus",
            created_at AS "createdAt", updated_at AS "updatedAt", erased_at AS "erasedAt"
       FROM candidates WHERE id = $1 AND organisation_id = $2`,
    [candidateId, organisationId],
  );
  if (!profile[0]) throw notFound('Candidate');
  const { rows: entitlements } = await q.query(
    `SELECT a.id, s.name AS "sessionName", s.starts_at AS "startsAt", s.ends_at AS "endsAt", a.status, a.extra_minutes AS "extraMinutes",
            v.manifest->>'name' AS "examName", v.manifest->>'code' AS "examCode"
       FROM exam_assignments a JOIN sessions s ON s.id = a.session_id JOIN exam_versions v ON v.id = s.exam_version_id
      WHERE a.candidate_id = $1 AND a.organisation_id = $2 ORDER BY s.starts_at`,
    [candidateId, organisationId],
  );
  const { rows: checks } = await q.query(
    `SELECT rc.assignment_id AS "entitlementId", rc.passed, rc.checks, rc.report, host(rc.client_ip) AS "ipAddress", rc.created_at AS "checkedAt"
       FROM readiness_checks rc JOIN exam_assignments a ON a.id = rc.assignment_id
      WHERE a.candidate_id = $1 AND a.organisation_id = $2 ORDER BY rc.created_at`,
    [candidateId, organisationId],
  );
  const { rows: attempts } = await q.query<{ id: string } & Record<string, unknown>>(
    `SELECT at.id, at.assignment_id AS "entitlementId", at.status, at.started_at AS "startedAt", at.deadline_at AS "deadlineAt",
            at.submitted_at AS "submittedAt", at.submitted_by AS "submittedBy",
            sub.id AS "receiptId", sub.status AS "submissionStatus", sub.package_sha256 AS "packageSha256",
            CASE WHEN NOT $3::boolean OR r.status = 'released' THEN json_build_object('score', r.score, 'maxScore', r.max_score, 'status', r.status, 'releasedAt', r.released_at) END AS result
       FROM attempts at JOIN exam_assignments a ON a.id = at.assignment_id
       LEFT JOIN submissions sub ON sub.attempt_id = at.id
       LEFT JOIN results r ON r.attempt_id = at.id
      WHERE a.candidate_id = $1 AND at.organisation_id = $2 ORDER BY at.started_at`,
    [candidateId, organisationId, opts.released],
  );
  const detail = [];
  for (const at of attempts) {
    const [answers, events, messages, recordings, files] = await Promise.all([
      q.query(`SELECT question_id AS "questionId", response, saved_at AS "savedAt" FROM answers WHERE attempt_id = $1 ORDER BY question_id`, [at.id]),
      q.query(`SELECT type, severity, occurred_at AS "occurredAt", data - 'byUserId' AS data FROM events WHERE attempt_id = $1 ORDER BY occurred_at, seq`, [at.id]),
      q.query(`SELECT kind, body, created_at AS "sentAt" FROM attempt_messages WHERE attempt_id = $1 ORDER BY seq`, [at.id]),
      q.query(
        `SELECT rs.stream_type AS stream, count(*)::int AS pieces, coalesce(sum(rc.size_bytes), 0)::bigint AS bytes,
                count(*) FILTER (WHERE rc.retention_state = 'deleted')::int AS deleted
           FROM recording_streams rs JOIN recording_chunks rc ON rc.stream_id = rs.id WHERE rs.attempt_id = $1 GROUP BY rs.stream_type`,
        [at.id],
      ),
      q.query(`SELECT file_name AS "fileName", content_type AS "contentType", size_bytes AS "sizeBytes", created_at AS "uploadedAt", deleted_at AS "deletedAt" FROM attempt_files WHERE attempt_id = $1`, [at.id]),
    ]);
    detail.push({ ...at, answers: answers.rows, events: events.rows, messages: messages.rows, recordings: recordings.rows, files: files.rows });
  }
  const { rows: cases } = await q.query(
    `SELECT id, category, scope, status, summary, details, reply, created_at AS "createdAt", replied_at AS "repliedAt"
       FROM support_cases WHERE candidate_id = $1 AND organisation_id = $2 ORDER BY created_at`,
    [candidateId, organisationId],
  );
  return { exportedAt: new Date().toISOString(), candidate: profile[0], entitlements, deviceChecks: checks, attempts: detail, supportCases: cases };
}

export async function governanceRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const store = deps.store;

  // Holds (spec section 19): keep an attempt's recordings and files past the
  // retention period while an appeal or investigation runs.
  app.post('/attempts/:id/hold', { preHandler: authorize('result:release') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { reason } = parse(holdBody, req.body);
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE attempts SET hold_reason = $3, held_by = $4, held_at = now() WHERE id = $1 AND organisation_id = $2`,
        [id, auth.organisationId, reason, auth.userId],
      );
      if (!rowCount) throw notFound('Attempt');
      await audit(tx, { ...auditFrom(req), action: 'attempt.hold', targetType: 'attempt', targetId: id, data: { reason } });
      return { held: true, reason };
    });
  });

  app.delete('/attempts/:id/hold', { preHandler: authorize('result:release') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    return withTransaction(db, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE attempts SET hold_reason = NULL, held_by = NULL, held_at = NULL WHERE id = $1 AND organisation_id = $2`,
        [id, auth.organisationId],
      );
      if (!rowCount) throw notFound('Attempt');
      await audit(tx, { ...auditFrom(req), action: 'attempt.hold_lifted', targetType: 'attempt', targetId: id });
      return { held: false };
    });
  });

  // Data export for the organisation, for example to answer a request from the candidate.
  app.get('/candidates/:id/export', { preHandler: authorize('candidate:view') }, async (req, reply) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const data = await candidateData(db, auth.organisationId, id, { released: false });
    await withTransaction(db, (tx) => audit(tx, { ...auditFrom(req), action: 'candidate.export', targetType: 'candidate', targetId: id }));
    return reply.header('content-disposition', `attachment; filename="candidate-${id}.json"`).send(data);
  });

  // A candidate's own copy of what this organisation holds about them.
  app.get('/me/export', async (req, reply) => {
    const auth = requireCandidate(req);
    const data = await candidateData(db, auth.organisationId, auth.candidateId, { released: true });
    await withTransaction(db, (tx) => audit(tx, { ...auditFrom(req), action: 'candidate.self_export', targetType: 'candidate', targetId: auth.candidateId }));
    return reply.header('content-disposition', 'attachment; filename="my-examguard-data.json"').send(data);
  });

  // Erasure (spec section 19): removes what identifies a candidate, their
  // answers, recordings and files, and keeps the bare record that an attempt
  // happened and what it scored, so results and the audit trail still add up.
  // Only the owner, who manages security, can do this, and the email typed
  // back must match.
  app.post('/candidates/:id/erase', { preHandler: authorize('organisation:manage_security') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { confirmEmail } = parse(eraseBody, req.body);
    const keys: string[] = [];
    const out = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ email: string; user_id: string | null; erased_at: Date | null }>(
        'SELECT email, user_id, erased_at FROM candidates WHERE id = $1 AND organisation_id = $2 FOR UPDATE',
        [id, auth.organisationId],
      );
      const c = rows[0];
      if (!c) throw notFound('Candidate');
      if (c.erased_at) throw conflict('This candidate has already been erased');
      if (confirmEmail.toLowerCase() !== c.email.toLowerCase()) throw badRequest('Type the candidate’s email address to confirm');
      const { rows: blocking } = await tx.query<{ active: number; held: number }>(
        `SELECT count(*) FILTER (WHERE at.status = 'active')::int AS active, count(*) FILTER (WHERE at.hold_reason IS NOT NULL)::int AS held
           FROM attempts at JOIN exam_assignments a ON a.id = at.assignment_id WHERE a.candidate_id = $1`,
        [id],
      );
      if (blocking[0]!.active) throw conflict('This candidate is sitting an exam now');
      if (blocking[0]!.held) throw conflict('An attempt by this candidate is on hold for an appeal or investigation. Lift the hold first.');

      const attempts = `(SELECT at.id FROM attempts at JOIN exam_assignments a ON a.id = at.assignment_id WHERE a.candidate_id = $1)`;
      const { rows: chunks } = await tx.query<{ id: string; storage_key: string }>(
        `SELECT rc.id, rc.storage_key FROM recording_chunks rc JOIN recording_streams rs ON rs.id = rc.stream_id
          WHERE rs.attempt_id IN ${attempts} AND rc.retention_state = 'retained' AND rc.storage_key IS NOT NULL`,
        [id],
      );
      const { rows: files } = await tx.query<{ storage_key: string }>(`SELECT storage_key FROM attempt_files WHERE attempt_id IN ${attempts} AND deleted_at IS NULL`, [id]);
      const { rows: stills } = await tx.query<{ snapshot_key: string }>(`SELECT snapshot_key FROM attempts WHERE id IN ${attempts} AND snapshot_key IS NOT NULL`, [id]);
      keys.push(...chunks.map((k) => k.storage_key), ...files.map((f) => f.storage_key), ...stills.map((s) => s.snapshot_key));

      await tx.query(`UPDATE recording_chunks SET retention_state = 'deleted' WHERE id = ANY($1::uuid[])`, [chunks.map((k) => k.id)]);
      await tx.query(`UPDATE attempt_files SET deleted_at = now(), file_name = 'erased' WHERE attempt_id IN ${attempts}`, [id]);
      await tx.query(`UPDATE attempts SET snapshot_key = NULL WHERE id IN ${attempts}`, [id]);
      await tx.query(`UPDATE answers SET response = '{}'::jsonb WHERE attempt_id IN ${attempts}`, [id]);
      await tx.query(`UPDATE attempt_messages SET body = '[erased]' WHERE attempt_id IN ${attempts}`, [id]);
      await tx.query(`UPDATE events SET data = '{}'::jsonb WHERE attempt_id IN ${attempts}`, [id]);
      await tx.query(`UPDATE readiness_checks SET report = '{}'::jsonb, client_ip = NULL WHERE assignment_id IN (SELECT id FROM exam_assignments WHERE candidate_id = $1)`, [id]);
      await tx.query(`UPDATE support_cases SET summary = '[erased]', details = NULL, reply = NULL WHERE candidate_id = $1`, [id]);
      await tx.query(`UPDATE exam_assignments SET status = 'revoked' WHERE candidate_id = $1 AND status IN ('assigned', 'precheck_complete')`, [id]);
      await tx.query(
        `UPDATE candidates SET email = 'erased-' || id || '@erased.invalid', full_name = 'Erased candidate', student_id = NULL, programme = NULL,
                status = 'blocked', erased_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      );
      await tx.query(`DELETE FROM candidate_tokens WHERE candidate_id = $1`, [id]);

      // The sign in account goes too, unless it is used elsewhere: as staff, or as a candidate of another organisation.
      let accountErased = false;
      if (c.user_id) {
        const { rows: other } = await tx.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM organisation_users WHERE user_id = $1) + (SELECT count(*) FROM candidates WHERE user_id = $1 AND id <> $2) AS n`,
          [c.user_id, id],
        );
        await tx.query(`UPDATE candidates SET user_id = NULL WHERE id = $1`, [id]);
        if (Number(other[0]!.n) === 0) {
          await tx.query(
            `UPDATE users SET email = 'erased-' || id || '@erased.invalid', display_name = 'Erased', password_hash = NULL,
                    totp_secret = NULL, totp_pending = NULL WHERE id = $1 AND platform_role IS NULL`,
            [c.user_id],
          );
          await tx.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [c.user_id]);
          await tx.query(`DELETE FROM notifications WHERE recipient_user_id = $1`, [c.user_id]);
          accountErased = true;
        } else {
          await tx.query(`DELETE FROM refresh_tokens WHERE user_id = $1 AND organisation_id = $2`, [c.user_id, auth.organisationId]);
        }
      }
      await tx.query(`DELETE FROM notifications WHERE organisation_id = $1 AND lower(recipient_email) = lower($2)`, [auth.organisationId, c.email]);
      // The audit entry names the record, not the person.
      await audit(tx, {
        ...auditFrom(req),
        action: 'candidate.erase',
        targetType: 'candidate',
        targetId: id,
        data: { recordingPieces: chunks.length, files: files.length, accountErased },
      });
      return { erased: true, recordingPieces: chunks.length, files: files.length, accountErased };
    });
    // Objects go after the commit; a failure here leaves an orphaned file, never a record pointing at nothing.
    if (store) for (const key of keys) await store.delete(key).catch((err) => req.log.error(err, 'erasure could not delete an object'));
    return out;
  });

  // Support cases, candidate side (spec section 23).
  app.post('/me/support', async (req, reply) => {
    const auth = requireCandidate(req);
    const body = parse(caseBody, req.body);
    const created = await withTransaction(db, async (tx) => {
      const { rows: open } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM support_cases WHERE candidate_id = $1 AND status <> 'resolved'`,
        [auth.candidateId],
      );
      if (open[0]!.n >= MAX_OPEN_CASES) throw conflict('You already have several open requests. Wait for a reply before sending more.');
      if (body.entitlementId) {
        const { rowCount } = await tx.query('SELECT 1 FROM exam_assignments WHERE id = $1 AND candidate_id = $2', [body.entitlementId, auth.candidateId]);
        if (!rowCount) throw notFound('Entitlement');
      }
      const scope = PLATFORM_CATEGORIES.has(body.category) ? 'platform' : 'organisation';
      const { rows } = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO support_cases (organisation_id, candidate_id, raised_by, assignment_id, category, scope, summary, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
        [auth.organisationId, auth.candidateId, auth.userId, body.entitlementId ?? null, body.category, scope, body.summary, body.details ?? null],
      );
      await notifyStaff(tx, {
        organisationId: auth.organisationId,
        permission: 'support:manage',
        kind: 'support_case_opened',
        payload: { caseId: rows[0]!.id, category: body.category, summary: body.summary },
      });
      await audit(tx, { ...auditFrom(req), action: 'support.open', targetType: 'support_case', targetId: rows[0]!.id, data: { category: body.category, scope } });
      return { id: rows[0]!.id, scope, status: 'open', createdAt: rows[0]!.created_at };
    });
    return reply.code(201).send(created);
  });

  app.get('/me/support', async (req) => {
    const auth = requireCandidate(req);
    const { rows } = await db.query(
      `SELECT id, category, scope, status, summary, details, reply, created_at AS "createdAt", replied_at AS "repliedAt", updated_at AS "updatedAt"
         FROM support_cases WHERE candidate_id = $1 AND organisation_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [auth.candidateId, auth.organisationId],
    );
    return { items: rows };
  });

  // Staff side. A support agent sees the candidate behind a case, not the whole candidate list.
  const caseFields = `sc.id, sc.category, sc.scope, sc.status, sc.summary, sc.details, sc.reply, sc.created_at AS "createdAt",
                      sc.replied_at AS "repliedAt", sc.updated_at AS "updatedAt", ru.display_name AS "repliedBy",
                      c.full_name AS "candidateName", c.email AS "candidateEmail"`;

  app.get('/support-cases', { preHandler: authorize('support:manage') }, async (req) => {
    const auth = requireOrg(req);
    const q = parse(caseList, req.query);
    const { rows } = await db.query(
      `SELECT ${caseFields} FROM support_cases sc
         LEFT JOIN candidates c ON c.id = sc.candidate_id LEFT JOIN users ru ON ru.id = sc.replied_by
        WHERE sc.organisation_id = $1 AND ($2 = 'all' OR sc.status = $2)
        ORDER BY (sc.status = 'resolved'), sc.created_at DESC LIMIT $3`,
      [auth.organisationId, q.status, q.limit],
    );
    return { items: rows };
  });

  async function caseDetail(q: Queryable, caseId: string, organisationId: string | null) {
    const { rows } = await q.query<Record<string, unknown> & { assignmentId: string | null; organisationId: string }>(
      `SELECT ${caseFields}, sc.organisation_id AS "organisationId", o.name AS "organisationName", sc.assignment_id AS "assignmentId",
              c.student_id AS "studentId", c.status AS "candidateStatus", c.identity_status AS "identityStatus",
              s.name AS "sessionName", s.starts_at AS "sessionStartsAt", a.status AS "entitlementStatus"
         FROM support_cases sc
         JOIN organisations o ON o.id = sc.organisation_id
         LEFT JOIN candidates c ON c.id = sc.candidate_id
         LEFT JOIN users ru ON ru.id = sc.replied_by
         LEFT JOIN exam_assignments a ON a.id = sc.assignment_id
         LEFT JOIN sessions s ON s.id = a.session_id
        WHERE sc.id = $1 AND ($2::uuid IS NULL OR sc.organisation_id = $2)`,
      [caseId, organisationId],
    );
    const row = rows[0];
    if (!row) throw notFound('Support case');
    // The latest device check for the exam the case is about: most platform questions start there.
    const { rows: check } = row.assignmentId
      ? await q.query(
          `SELECT passed, checks, report->'os' AS os, report->>'appVersion' AS "appVersion", created_at AS "checkedAt"
             FROM readiness_checks WHERE assignment_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [row.assignmentId],
        )
      : { rows: [] };
    return { ...row, lastDeviceCheck: check[0] ?? null };
  }

  async function updateCase(req: Parameters<typeof requireAuth>[0], id: string, organisationId: string | null) {
    const auth = requireAuth(req);
    const body = parse(caseUpdate, req.body);
    if (!body.status && !body.reply && !body.scope) throw badRequest('Nothing to change');
    return withTransaction(db, async (tx) => {
      const { rows } = await tx.query<{ organisation_id: string; raised_by: string | null; candidate_email: string | null; summary: string }>(
        `SELECT sc.organisation_id, sc.raised_by, c.email AS candidate_email, sc.summary FROM support_cases sc LEFT JOIN candidates c ON c.id = sc.candidate_id
          WHERE sc.id = $1 AND ($2::uuid IS NULL OR sc.organisation_id = $2) AND ($2::uuid IS NOT NULL OR sc.scope = 'platform') FOR UPDATE OF sc`,
        [id, organisationId],
      );
      const c = rows[0];
      if (!c) throw notFound('Support case');
      await tx.query(
        `UPDATE support_cases
            SET status = coalesce($2, CASE WHEN $3::text IS NOT NULL AND status = 'open' THEN 'in_progress' ELSE status END),
                reply = coalesce($3, reply),
                replied_by = CASE WHEN $3::text IS NOT NULL THEN $4 ELSE replied_by END,
                replied_at = CASE WHEN $3::text IS NOT NULL THEN now() ELSE replied_at END,
                scope = coalesce($5, scope),
                updated_at = now()
          WHERE id = $1`,
        [id, body.status ?? null, body.reply ?? null, auth.userId, body.scope ?? null],
      );
      if (body.reply) {
        await notify(tx, {
          organisationId: c.organisation_id,
          kind: 'support_reply',
          channel: 'email',
          recipientUserId: c.raised_by,
          recipientEmail: c.candidate_email,
          payload: { caseId: id, summary: c.summary },
        });
      }
      await audit(tx, {
        organisationId: c.organisation_id,
        actorUserId: auth.userId,
        ip: req.ip,
        action: 'support.update',
        targetType: 'support_case',
        targetId: id,
        data: { status: body.status, scope: body.scope, replied: Boolean(body.reply) },
      });
      return caseDetail(tx, id, organisationId);
    });
  }

  app.get('/support-cases/:id', { preHandler: authorize('support:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const detail = await caseDetail(db, id, auth.organisationId);
    await withTransaction(db, (tx) => audit(tx, { ...auditFrom(req), action: 'support.view', targetType: 'support_case', targetId: id }));
    return detail;
  });

  app.patch('/support-cases/:id', { preHandler: authorize('support:manage') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    return updateCase(req, id, auth.organisationId);
  });

  // Platform support sees only cases marked as platform problems, across organisations.
  function requirePlatform(req: Parameters<typeof requireAuth>[0]) {
    if (!requireAuth(req).isSuperAdmin) throw forbidden('Platform support only');
  }

  app.get('/platform/support-cases', async (req) => {
    requirePlatform(req);
    const q = parse(caseList, req.query);
    const { rows } = await db.query(
      `SELECT ${caseFields}, o.name AS "organisationName" FROM support_cases sc
         JOIN organisations o ON o.id = sc.organisation_id
         LEFT JOIN candidates c ON c.id = sc.candidate_id LEFT JOIN users ru ON ru.id = sc.replied_by
        WHERE sc.scope = 'platform' AND ($1 = 'all' OR sc.status = $1)
        ORDER BY (sc.status = 'resolved'), sc.created_at DESC LIMIT $2`,
      [q.status, q.limit],
    );
    return { items: rows };
  });

  app.patch('/platform/support-cases/:id', async (req) => {
    requirePlatform(req);
    const { id } = parse(idParams, req.params);
    return updateCase(req, id, null);
  });
}
