import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { type Queryable, type Tx, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { authorize, requireCandidate, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { examConfig } from '../examConfig.js';
import { enforceClient } from '../client.js';
import { existingReceipt, finalizeAttempt, type Receipt } from '../attempts.js';
import { COUNTED_EVENT_TYPES, decideAction, RULE_EVENT_TYPES, RULE_EVENTS } from '../rules.js';
import { idParams, page, pagination, parse } from '../validation.js';

const answerResponse = z.union([
  z.strictObject({ optionId: z.uuid() }),
  z.strictObject({ optionIds: z.array(z.uuid()).max(26) }),
  z.strictObject({ text: z.string().max(20000) }),
]);

const answerBody = z.object({
  questionId: z.uuid(),
  // Client side counter that only ever increases; the highest value wins, so
  // retries and out of order requests cannot overwrite a newer answer.
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  response: answerResponse,
});

const answersBatch = z.array(answerBody).max(200);

const eventsBody = z.object({
  events: z
    .array(
      z.object({
        // Chosen by the app, so a retry after a lost response cannot record an event twice.
        id: z.uuid(),
        type: z.enum(RULE_EVENT_TYPES),
        occurredAt: z.iso.datetime({ offset: true }),
        data: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
      }),
    )
    .min(1)
    .max(50),
});

const startBody = z.object({ assignmentId: z.uuid() });
const heartbeatBody = z.object({ afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) });
const saveBody = z.object({ answers: answersBatch.default([]), position: z.number().int().min(0).max(10_000).optional() });
const submitBody = z.object({ answers: answersBatch.default([]) });

interface ManifestQuestion {
  id: string;
  type: string;
  options: { id: string }[];
}

interface AttemptRow {
  id: string;
  organisation_id: string;
  assignment_id: string;
  exam_version_id: string;
  status: string;
  state: { position?: number };
  started_at: Date;
  deadline_at: Date;
  expired: boolean;
  now: Date;
  /** Seconds since the app last checked in, or null before the first check in. */
  away_seconds: number | null;
  manifest: { questions: ManifestQuestion[]; config?: unknown };
}

/** A silence longer than this is recorded as the candidate having been offline. */
export const OFFLINE_EVENT_SECONDS = 60;

/**
 * Notes that the app is in touch. After a long silence it records how long
 * the candidate was away, and whether that went past the exam's offline
 * limit, for the invigilator and the reviewers. Being offline does not end
 * the exam: the answers are kept on the device and the timer keeps running.
 */
async function touch(tx: Tx, attempt: AttemptRow): Promise<void> {
  if (attempt.status === 'active' && attempt.away_seconds !== null && attempt.away_seconds >= OFFLINE_EVENT_SECONDS) {
    const offline = examConfig.parse(attempt.manifest.config ?? {}).offline;
    const exceeded = !offline.allowed || attempt.away_seconds > offline.maxOfflineMinutes * 60;
    await tx.query(
      `INSERT INTO events (organisation_id, attempt_id, type, severity, occurred_at, data)
       VALUES ($1, $2, $3, $4, date_trunc('milliseconds', now()), $5)`,
      [
        attempt.organisation_id,
        attempt.id,
        exceeded ? 'offline_limit_exceeded' : 'reconnected',
        exceeded ? 'high' : 'warning',
        { offlineSeconds: attempt.away_seconds, allowedMinutes: offline.allowed ? offline.maxOfflineMinutes : 0 },
      ],
    );
  }
  await tx.query('UPDATE attempts SET last_seen_at = now() WHERE id = $1', [attempt.id]);
}

function validateAnswer(q: ManifestQuestion, response: z.infer<typeof answerResponse>): void {
  const optionIds = new Set(q.options.map((o) => o.id));
  const fail = (msg: string) => {
    throw badRequest(`Invalid answer for question ${q.id}: ${msg}`);
  };
  switch (q.type) {
    case 'mcq':
    case 'true_false':
      if (!('optionId' in response)) fail('expected optionId');
      else if (!optionIds.has(response.optionId)) fail('unknown option');
      break;
    case 'multiple_response':
      if (!('optionIds' in response)) fail('expected optionIds');
      else if (new Set(response.optionIds).size !== response.optionIds.length || !response.optionIds.every((id) => optionIds.has(id)))
        fail('unknown or repeated option');
      break;
    case 'short_answer':
      if (!('text' in response)) fail('expected text');
      else if (response.text.length > 2000) fail('answer is too long');
      break;
    case 'essay':
      if (!('text' in response)) fail('expected text');
      break;
    default:
      fail(`${q.type} questions are not supported yet`);
  }
}

async function applyAnswers(tx: Tx, attempt: AttemptRow, answers: z.infer<typeof answersBatch>): Promise<{ questionId: string; seq: number }[]> {
  const byId = new Map(attempt.manifest.questions.map((q) => [q.id, q]));
  for (const a of answers) {
    const q = byId.get(a.questionId);
    if (!q) throw badRequest(`Question ${a.questionId} is not part of this exam`);
    validateAnswer(q, a.response);
  }
  // A later entry for the same question in one batch supersedes an earlier one.
  const latest = new Map<string, (typeof answers)[number]>();
  for (const a of answers) {
    const prev = latest.get(a.questionId);
    if (!prev || a.seq > prev.seq) latest.set(a.questionId, a);
  }
  for (const a of latest.values()) {
    await tx.query(
      `INSERT INTO answers (attempt_id, question_id, response, client_seq)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (attempt_id, question_id) DO UPDATE
         SET response = EXCLUDED.response, client_seq = EXCLUDED.client_seq, saved_at = now()
       WHERE answers.client_seq < EXCLUDED.client_seq`,
      [attempt.id, a.questionId, a.response, a.seq],
    );
  }
  if (!latest.size) return [];
  // Acknowledge whatever the server now holds: if it already had something
  // newer, the client can safely drop its older copy.
  const { rows } = await tx.query<{ question_id: string; client_seq: string }>(
    'SELECT question_id, client_seq FROM answers WHERE attempt_id = $1 AND question_id = ANY($2::uuid[])',
    [attempt.id, [...latest.keys()]],
  );
  return rows.map((r) => ({ questionId: r.question_id, seq: Number(r.client_seq) }));
}

async function attemptView(q: Queryable, attemptId: string) {
  const { rows } = await q.query<{
    id: string;
    assignment_id: string;
    status: string;
    state: { position?: number };
    started_at: Date;
    deadline_at: Date;
    now: Date;
  }>(
    `SELECT id, assignment_id, status, state, started_at, deadline_at, now() FROM attempts WHERE id = $1`,
    [attemptId],
  );
  const a = rows[0]!;
  const { rows: answers } = await q.query<{ question_id: string; response: unknown; client_seq: string }>(
    'SELECT question_id, response, client_seq FROM answers WHERE attempt_id = $1 ORDER BY question_id',
    [attemptId],
  );
  return {
    id: a.id,
    assignmentId: a.assignment_id,
    status: a.status,
    startedAt: a.started_at.toISOString(),
    deadlineAt: a.deadline_at.toISOString(),
    serverTime: a.now.toISOString(),
    position: a.state.position ?? 0,
    answers: answers.map((r) => ({ questionId: r.question_id, response: r.response, seq: Number(r.client_seq) })),
    receipt: a.status === 'active' ? null : await existingReceipt(q, attemptId),
  };
}

export async function attemptRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;

  /** Loads and locks one of the calling candidate's attempts. */
  async function lockAttempt(tx: Tx, attemptId: string, organisationId: string, candidateId: string): Promise<AttemptRow> {
    const { rows } = await tx.query<AttemptRow>(
      `SELECT at.id, at.organisation_id, at.assignment_id, at.exam_version_id, at.status, at.state,
              at.started_at, at.deadline_at, now() AS now,
              now() > at.deadline_at + make_interval(secs => $4) AS expired,
              extract(epoch FROM now() - at.last_seen_at)::int AS away_seconds,
              v.manifest
         FROM attempts at
         JOIN exam_assignments a ON a.id = at.assignment_id
         JOIN exam_versions v ON v.id = at.exam_version_id
        WHERE at.id = $1 AND at.organisation_id = $2 AND a.candidate_id = $3
        FOR UPDATE OF at`,
      [attemptId, organisationId, candidateId, config.attemptGraceSeconds],
    );
    if (!rows[0]) throw notFound('Attempt');
    return rows[0];
  }

  app.post('/attempts/start', async (req, reply) => {
    const auth = requireCandidate(req);
    const { assignmentId } = parse(startBody, req.body);

    const result = await withTransaction(db, async (tx) => {
      // Take the lock in its own statement. If the state were read in the same
      // statement, a request that waited on the lock would still see the
      // snapshot from before the winner committed: it would find the
      // entitlement already active but no attempt, and wrongly refuse.
      const { rowCount: owned } = await tx.query(
        'SELECT 1 FROM exam_assignments WHERE id = $1 AND candidate_id = $2 AND organisation_id = $3 FOR UPDATE',
        [assignmentId, auth.candidateId, auth.organisationId],
      );
      if (!owned) throw notFound('Entitlement');

      const { rows } = await tx.query<{
        status: string;
        candidate_status: string;
        session_status: string;
        starts_at: Date;
        ends_at: Date;
        before_start: boolean;
        after_window: boolean;
        after_end: boolean;
        exam_version_id: string;
        config: unknown;
        attempt_id: string | null;
        platform: string | null;
      }>(
        `SELECT a.status, c.status AS candidate_status, s.status AS session_status, s.starts_at, s.ends_at,
                s.exam_version_id, v.manifest->'config' AS config,
                (SELECT id FROM attempts WHERE assignment_id = a.id) AS attempt_id,
                now() < s.starts_at AS before_start,
                now() > s.ends_at AS after_end,
                now() > s.starts_at + make_interval(mins => coalesce((v.manifest#>>'{config,timing,startWindowMinutes}')::int, 15)
                                                             + coalesce((v.manifest#>>'{config,timing,lateEntryMinutes}')::int, 0)) AS after_window,
                rc.report#>>'{os,platform}' AS platform
           FROM exam_assignments a
           JOIN candidates c ON c.id = a.candidate_id
           JOIN sessions s ON s.id = a.session_id
           JOIN exam_versions v ON v.id = s.exam_version_id
           LEFT JOIN readiness_checks rc ON rc.id = a.last_check_id
          WHERE a.id = $1 AND a.candidate_id = $2 AND a.organisation_id = $3`,
        [assignmentId, auth.candidateId, auth.organisationId],
      );
      const row = rows[0];
      if (!row || row.status === 'revoked') throw notFound('Entitlement');

      // Starting again returns the running attempt, so a restart or a second
      // tab resumes rather than creating anything new.
      if (row.attempt_id) {
        const attempt = await lockAttempt(tx, row.attempt_id, auth.organisationId, auth.candidateId);
        if (attempt.status === 'active' && attempt.expired) {
          await finalizeAttempt(tx, config, attempt.id, 'timer', { userId: auth.userId, ip: req.ip });
        } else if (attempt.status === 'active') {
          await tx.query(
            `INSERT INTO events (organisation_id, attempt_id, type, severity, occurred_at, data) VALUES ($1, $2, 'attempt_resumed', 'info', now(), $3)`,
            [auth.organisationId, attempt.id, { ip: req.ip }],
          );
        }
        return { created: false, view: await attemptView(tx, row.attempt_id) };
      }

      if (row.candidate_status !== 'approved') throw conflict('Candidate is not approved');
      if (row.status !== 'precheck_complete') throw conflict('Complete the device check first');
      if (!['scheduled', 'open'].includes(row.session_status)) throw conflict(`Session is ${row.session_status}`);
      if (row.before_start) throw conflict(`The exam starts at ${row.starts_at.toISOString()}`);
      if (row.after_end || row.after_window) throw conflict('The start window for this exam has closed; contact exam support');

      const parsed = examConfig.parse(row.config ?? {});
      enforceClient(req, parsed, row.platform);
      const duration = parsed.timing.durationMinutes;
      if (!duration) throw conflict('This exam has no duration configured');

      const { rows: created } = await tx.query<{ id: string }>(
        `INSERT INTO attempts (organisation_id, assignment_id, exam_version_id, deadline_at)
         VALUES ($1, $2, $3, LEAST(now() + make_interval(mins => $4), $5)) RETURNING id`,
        [auth.organisationId, assignmentId, row.exam_version_id, duration, row.ends_at],
      );
      const attemptId = created[0]!.id;
      await tx.query(`UPDATE exam_assignments SET status = 'active' WHERE id = $1`, [assignmentId]);
      await tx.query(
        `INSERT INTO events (organisation_id, attempt_id, type, severity, occurred_at, data) VALUES ($1, $2, 'attempt_started', 'info', now(), $3)`,
        [auth.organisationId, attemptId, { ip: req.ip }],
      );
      await audit(tx, { ...auditFrom(req), action: 'attempt.start', targetType: 'attempt', targetId: attemptId });
      return { created: true, view: await attemptView(tx, attemptId) };
    });

    return reply.code(result.created ? 201 : 200).send({ ...result.view, resumed: !result.created });
  });

  app.get('/attempts/:id', async (req) => {
    const auth = requireCandidate(req);
    const { id } = parse(idParams, req.params);
    return withTransaction(db, async (tx) => {
      const attempt = await lockAttempt(tx, id, auth.organisationId, auth.candidateId);
      if (attempt.status === 'active' && attempt.expired) {
        await finalizeAttempt(tx, config, id, 'timer', { userId: auth.userId, ip: req.ip });
      }
      return attemptView(tx, id);
    });
  });

  app.patch('/attempts/:id/state', async (req) => {
    const auth = requireCandidate(req);
    const { id } = parse(idParams, req.params);
    const body = parse(saveBody, req.body);

    const outcome = await withTransaction(db, async (tx) => {
      const attempt = await lockAttempt(tx, id, auth.organisationId, auth.candidateId);
      if (attempt.status !== 'active') return { closed: await existingReceipt(tx, id) };
      if (attempt.expired) {
        // Too late to accept more; close it with what was saved in time.
        return { closed: await finalizeAttempt(tx, config, id, 'timer', { userId: auth.userId, ip: req.ip }) };
      }
      const acked = await applyAnswers(tx, attempt, body.answers);
      await touch(tx, attempt);
      if (body.position !== undefined) {
        await tx.query('UPDATE attempts SET state = jsonb_set(state, $2, to_jsonb($3::int)) WHERE id = $1', [id, ['position'], body.position]);
      }
      return { acked, deadlineAt: attempt.deadline_at.toISOString(), serverTime: attempt.now.toISOString() };
    });

    // Thrown after the transaction so a timer submission is committed first.
    if ('closed' in outcome) throw conflict('This attempt is closed', { receipt: outcome.closed });
    return outcome;
  });

  // The app checks in every few seconds while the exam is open. The reply
  // carries new messages from the invigilator, the current deadline (which
  // moves when extra time is given) and whether the attempt is still open.
  app.post('/attempts/:id/heartbeat', async (req) => {
    const auth = requireCandidate(req);
    const { id } = parse(idParams, req.params);
    const { afterSeq } = parse(heartbeatBody, req.body ?? {});
    return withTransaction(db, async (tx) => {
      const attempt = await lockAttempt(tx, id, auth.organisationId, auth.candidateId);
      if (attempt.status === 'active' && attempt.expired) {
        await finalizeAttempt(tx, config, id, 'timer', { userId: auth.userId, ip: req.ip });
      }
      await touch(tx, { ...attempt, status: attempt.status === 'active' && attempt.expired ? 'submitted' : attempt.status });
      const { rows: now } = await tx.query<{ status: string; deadline_at: Date; now: Date }>(
        `SELECT status, deadline_at, now() FROM attempts WHERE id = $1`,
        [id],
      );
      const { rows: messages } = await tx.query<{ id: string; seq: string; kind: string; body: string; created_at: Date }>(
        `UPDATE attempt_messages SET read_at = coalesce(read_at, now())
          WHERE attempt_id = $1 AND seq > $2 RETURNING id, seq, kind, body, created_at`,
        [id, afterSeq],
      );
      const current = now[0]!;
      let endedBy: 'invigilator' | 'rules' | null = null;
      if (current.status !== 'active') {
        const { rows: ended } = await tx.query<{ type: string }>(
          `SELECT type FROM events WHERE attempt_id = $1 AND type IN ('attempt_ended_by_invigilator', 'attempt_ended_for_rules')
            ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
          [id],
        );
        if (ended[0]) endedBy = ended[0].type === 'attempt_ended_by_invigilator' ? 'invigilator' : 'rules';
      }
      // A live call the invigilator has started, which the app should join.
      const { rows: calls } = await tx.query<{ id: string; voice: boolean }>(
        `SELECT id, voice FROM live_calls WHERE attempt_id = $1 AND status = 'open'`,
        [id],
      );
      return {
        status: current.status,
        endedBy,
        call: current.status === 'active' && calls[0] ? { id: calls[0].id, voice: calls[0].voice } : null,
        deadlineAt: current.deadline_at.toISOString(),
        serverTime: current.now.toISOString(),
        messages: messages
          .map((m) => ({ id: m.id, seq: Number(m.seq), kind: m.kind, body: m.body, createdAt: m.created_at.toISOString() }))
          .sort((a, b) => a.seq - b.seq),
        receipt: current.status === 'active' ? null : await existingReceipt(tx, id),
      };
    });
  });

  app.post('/attempts/:id/submit', async (req) => {
    const auth = requireCandidate(req);
    const { id } = parse(idParams, req.params);
    const body = parse(submitBody, req.body ?? {});

    return withTransaction(db, async (tx) => {
      const attempt = await lockAttempt(tx, id, auth.organisationId, auth.candidateId);
      // Already closed: return the original receipt, so a retry after a lost response is safe.
      if (attempt.status !== 'active') return { receipt: await existingReceipt(tx, id) };
      if (attempt.expired) {
        return { receipt: await finalizeAttempt(tx, config, id, 'timer', { userId: auth.userId, ip: req.ip }) };
      }
      await applyAnswers(tx, attempt, body.answers);
      const receipt: Receipt = await finalizeAttempt(tx, config, id, 'candidate', { userId: auth.userId, ip: req.ip });
      return { receipt };
    });
  });

  // Exam rule events from the candidate app. The server counts the violations
  // and applies the exam's policy, so the outcome never depends on the app.
  app.post('/attempts/:id/events', async (req) => {
    const auth = requireCandidate(req);
    const { id } = parse(idParams, req.params);
    const body = parse(eventsBody, req.body);

    const outcome = await withTransaction(db, async (tx) => {
      const attempt = await lockAttempt(tx, id, auth.organisationId, auth.candidateId);
      if (attempt.status !== 'active') return { closed: await existingReceipt(tx, id) };
      if (attempt.expired) {
        return { closed: await finalizeAttempt(tx, config, id, 'timer', { userId: auth.userId, ip: req.ip }) };
      }

      for (const e of body.events) {
        // The device clock is not trusted: a time outside the attempt is replaced by now.
        await tx.query(
          `INSERT INTO events (id, organisation_id, attempt_id, type, severity, occurred_at, data)
           VALUES ($1, $2, $3, $4, $5,
                   CASE WHEN $6::timestamptz BETWEEN $7 AND now() THEN $6::timestamptz ELSE now() END, $8)
           ON CONFLICT (id) DO NOTHING`,
          [e.id, auth.organisationId, id, e.type, RULE_EVENTS[e.type].severity, e.occurredAt, attempt.started_at, e.data ?? {}],
        );
      }

      const { rows } = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM events WHERE attempt_id = $1 AND type = ANY($2::text[])',
        [id, COUNTED_EVENT_TYPES],
      );
      const violations = rows[0]!.n;
      const security = examConfig.parse((attempt.manifest as { config?: unknown }).config ?? {}).security;
      const action = decideAction(security.violationPolicy, security.maxViolations, violations);
      const summary = { violations, policy: security.violationPolicy, maxViolations: security.maxViolations, action };

      if (action !== 'ended') return summary;

      await tx.query(
        `INSERT INTO events (organisation_id, attempt_id, type, severity, occurred_at, data)
         VALUES ($1, $2, 'attempt_ended_for_rules', 'high', date_trunc('milliseconds', now()), $3)`,
        [auth.organisationId, id, { violations, policy: security.violationPolicy }],
      );
      const receipt = await finalizeAttempt(tx, config, id, 'system', { userId: auth.userId, ip: req.ip });
      return { ...summary, receipt };
    });

    if ('closed' in outcome) throw conflict('This attempt is closed', { receipt: outcome.closed });
    return outcome;
  });

  // Everything that happened in an attempt, in order (spec section 16).
  app.get('/attempts/:id/timeline', { preHandler: authorize('report:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rowCount } = await db.query('SELECT 1 FROM attempts WHERE id = $1 AND organisation_id = $2', [id, auth.organisationId]);
    if (!rowCount) throw notFound('Attempt');
    const { rows } = await db.query(
      `SELECT type, severity, occurred_at AS "occurredAt", data FROM events
        WHERE attempt_id = $1 ORDER BY occurred_at, seq`,
      [id],
    );
    return { items: rows };
  });

  // Organisation view: who has started, submitted and how automatic marking went.
  app.get('/sessions/:id/attempts', { preHandler: authorize('report:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { limit, offset } = parse(pagination, req.query);
    const { rowCount } = await db.query('SELECT 1 FROM sessions WHERE id = $1 AND organisation_id = $2', [id, auth.organisationId]);
    if (!rowCount) throw notFound('Session');
    const { rows } = await db.query(
      `SELECT c.id AS "candidateId", c.full_name AS "fullName", a.id AS "assignmentId", a.status AS "entitlementStatus",
              at.id AS "attemptId", at.status, at.started_at AS "startedAt", at.submitted_at AS "submittedAt",
              at.submitted_by AS "submittedBy", r.score::float AS score, r.max_score::float AS "maxScore", r.status AS "markingStatus",
              (SELECT count(*)::int FROM events ev WHERE ev.attempt_id = at.id AND ev.type = ANY($5::text[])) AS violations
         FROM exam_assignments a
         JOIN candidates c ON c.id = a.candidate_id
         LEFT JOIN attempts at ON at.assignment_id = a.id
         LEFT JOIN results r ON r.attempt_id = at.id
        WHERE a.session_id = $1 AND a.organisation_id = $2 AND a.status <> 'revoked'
        ORDER BY c.full_name, a.id LIMIT $3 OFFSET $4`,
      [id, auth.organisationId, limit, offset, COUNTED_EVENT_TYPES],
    );
    return page(rows, limit, offset);
  });
}
