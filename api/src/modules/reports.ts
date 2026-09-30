import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { withTransaction } from '../db.js';
import { notFound } from '../errors.js';
import { authorize, requireOrg } from '../auth/context.js';
import { audit, auditFrom } from '../audit.js';
import { fileName, toCsv } from '../csv.js';
import { evidenceState, expectedStreams } from '../recording.js';
import { loadMarkingInput, markFrom, percent } from '../results.js';
import { COUNTED_EVENT_TYPES } from '../rules.js';
import { idParams, parse } from '../validation.js';

// Reports (spec sections 16 and 18). They state what happened, with times and
// sources; a technical event is shown as an event, never as a finding of
// misconduct. Every report can be downloaded as CSV for the organisation's
// own records.

const filters = z.object({
  sessionId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
const sessionFilter = z.object({ sessionId: z.uuid(), format: z.enum(['json', 'csv']).default('json') });

/**
 * Events staff record, which carry the acting user's id. Only these are
 * trusted for "raised by": a candidate's own rule events carry data from
 * their device, which must never be able to name a member of staff.
 */
const STAFF_EVENT_TYPES = [
  'invigilator_message',
  'invigilator_warning',
  'invigilator_note',
  'invigilator_flag',
  'time_extended',
  'attempt_ended_by_invigilator',
  'live_call_started',
  'live_call_ended',
];
// CASE, not AND: SQL does not promise to test the pattern before the cast.
const BY_USER = `LEFT JOIN users bu ON bu.id = CASE
                   WHEN e.type = ANY('{${STAFF_EVENT_TYPES.join(',')}}'::text[])
                    AND e.data->>'byUserId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   THEN (e.data->>'byUserId')::uuid END`;

const OFFLINE_TYPES = ['reconnected', 'offline_limit_exceeded'];
/** An attempt that has not checked in for this long is shown as offline. */
const ONLINE_SECONDS = 60;
/** High severity events this recent count as open incidents on the session health report. */
const RECENT_INCIDENT_MINUTES = 15;

function sendCsv(reply: FastifyReply, name: string, header: string[], rows: unknown[][]) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}.csv"`)
    .send(toCsv(header, rows));
}

export async function reportRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  async function sessionName(organisationId: string, sessionId: string | undefined): Promise<string | null> {
    if (!sessionId) return null;
    const { rows } = await db.query<{ name: string }>('SELECT name FROM sessions WHERE id = $1 AND organisation_id = $2', [sessionId, organisationId]);
    if (!rows[0]) throw notFound('Session');
    return rows[0].name;
  }

  // Warnings and high severity events: rule breaks, time offline beyond the
  // limit, recordings that stopped, invigilator flags and warnings.
  app.get('/reports/incidents', { preHandler: authorize('report:view') }, async (req, reply) => {
    const auth = requireOrg(req);
    const f = parse(filters, req.query);
    const name = await sessionName(auth.organisationId, f.sessionId);
    const where = `e.organisation_id = $1 AND e.severity IN ('warning', 'high')
                   AND ($2::uuid IS NULL OR a.session_id = $2) AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
                   AND ($4::timestamptz IS NULL OR e.occurred_at <= $4)`;
    const params = [auth.organisationId, f.sessionId ?? null, f.from ?? null, f.to ?? null];
    const { rows } = await db.query<{
      occurredAt: Date;
      type: string;
      severity: string;
      data: Record<string, unknown>;
      attemptId: string;
      candidateName: string;
      studentId: string | null;
      sessionName: string;
      raisedBy: string | null;
    }>(
      `SELECT e.occurred_at AS "occurredAt", e.type, e.severity, e.data, at.id AS "attemptId",
              c.full_name AS "candidateName", c.student_id AS "studentId", s.name AS "sessionName",
              coalesce(u.display_name, bu.display_name) AS "raisedBy"
         FROM events e
         JOIN attempts at ON at.id = e.attempt_id
         JOIN exam_assignments a ON a.id = at.assignment_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN sessions s ON s.id = a.session_id
         LEFT JOIN invigilators i ON i.id = e.invigilator_id
         LEFT JOIN users u ON u.id = i.user_id
         ${BY_USER}
        WHERE ${where}
        ORDER BY e.occurred_at DESC, e.seq DESC
        LIMIT $5 OFFSET $6`,
      [...params, f.limit, f.offset],
    );
    const { rows: byType } = await db.query<{ type: string; severity: string; count: number }>(
      `SELECT e.type, e.severity, count(*)::int AS count
         FROM events e JOIN attempts at ON at.id = e.attempt_id JOIN exam_assignments a ON a.id = at.assignment_id
        WHERE ${where} GROUP BY e.type, e.severity ORDER BY count DESC, e.type`,
      params,
    );
    if (f.format === 'csv') {
      return sendCsv(
        reply,
        `${fileName(name ?? 'all-sessions', 'report')}-incidents`,
        ['Time', 'Session', 'Candidate', 'Student ID', 'Event', 'Severity', 'Raised by', 'Details'],
        rows.map((r) => [r.occurredAt, r.sessionName, r.candidateName, r.studentId, r.type, r.severity, r.raisedBy ?? 'system', JSON.stringify(r.data)]),
      );
    }
    return { items: rows, byType, limit: f.limit, offset: f.offset, nextOffset: rows.length === f.limit ? f.offset + f.limit : null };
  });

  // Time candidates spent offline (spec section 18, blackout report). Each
  // return after a gap records how long it lasted and whether it went past
  // the exam's limit.
  app.get('/reports/blackouts', { preHandler: authorize('report:view') }, async (req, reply) => {
    const auth = requireOrg(req);
    const f = parse(filters, req.query);
    const name = await sessionName(auth.organisationId, f.sessionId);
    const { rows } = await db.query<{
      attemptId: string;
      candidateName: string;
      studentId: string | null;
      sessionName: string;
      interruptions: number;
      totalSeconds: number;
      longestSeconds: number;
      overLimit: number;
      firstAt: Date;
      lastAt: Date;
      attemptStatus: string;
      submissionStatus: string | null;
    }>(
      `SELECT at.id AS "attemptId", c.full_name AS "candidateName", c.student_id AS "studentId", s.name AS "sessionName",
              count(*)::int AS interruptions,
              sum((e.data->>'offlineSeconds')::int)::int AS "totalSeconds",
              max((e.data->>'offlineSeconds')::int)::int AS "longestSeconds",
              count(*) FILTER (WHERE e.type = 'offline_limit_exceeded')::int AS "overLimit",
              min(e.occurred_at) AS "firstAt", max(e.occurred_at) AS "lastAt",
              at.status AS "attemptStatus", sub.status AS "submissionStatus"
         FROM events e
         JOIN attempts at ON at.id = e.attempt_id
         JOIN exam_assignments a ON a.id = at.assignment_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN sessions s ON s.id = a.session_id
         LEFT JOIN submissions sub ON sub.attempt_id = at.id
        WHERE e.organisation_id = $1 AND e.type = ANY($2::text[])
          AND ($3::uuid IS NULL OR a.session_id = $3) AND ($4::timestamptz IS NULL OR e.occurred_at >= $4)
          AND ($5::timestamptz IS NULL OR e.occurred_at <= $5)
        GROUP BY at.id, c.full_name, c.student_id, s.name, sub.status
        ORDER BY "totalSeconds" DESC, c.full_name
        LIMIT $6 OFFSET $7`,
      [auth.organisationId, OFFLINE_TYPES, f.sessionId ?? null, f.from ?? null, f.to ?? null, f.limit, f.offset],
    );
    const summary = {
      candidatesAffected: rows.length,
      interruptions: rows.reduce((n, r) => n + r.interruptions, 0),
      totalSeconds: rows.reduce((n, r) => n + r.totalSeconds, 0),
      overLimit: rows.reduce((n, r) => n + r.overLimit, 0),
    };
    if (f.format === 'csv') {
      return sendCsv(
        reply,
        `${fileName(name ?? 'all-sessions', 'report')}-blackouts`,
        ['Session', 'Candidate', 'Student ID', 'Interruptions', 'Total seconds offline', 'Longest seconds', 'Over the limit', 'First', 'Last', 'Attempt', 'Submission'],
        rows.map((r) => [
          r.sessionName,
          r.candidateName,
          r.studentId,
          r.interruptions,
          r.totalSeconds,
          r.longestSeconds,
          r.overLimit,
          r.firstAt,
          r.lastAt,
          r.attemptStatus,
          r.submissionStatus,
        ]),
      );
    }
    return { summary, items: rows };
  });

  // Camera, microphone and screen: which pieces arrived, which are missing, and
  // where a recording stopped during the exam.
  app.get('/reports/recording-health', { preHandler: authorize('report:view') }, async (req, reply) => {
    const auth = requireOrg(req);
    const f = parse(sessionFilter, req.query);
    const name = (await sessionName(auth.organisationId, f.sessionId))!;
    const { rows: cfg } = await db.query<{ config: unknown }>(
      `SELECT v.manifest->'config' AS config FROM sessions s JOIN exam_versions v ON v.id = s.exam_version_id WHERE s.id = $1`,
      [f.sessionId],
    );
    const expected = expectedStreams(cfg[0]?.config);
    const { rows: attempts } = await db.query<{
      attemptId: string;
      candidateName: string;
      studentId: string | null;
      status: string;
      submissionStatus: string | null;
      stopped: number;
    }>(
      `SELECT at.id AS "attemptId", c.full_name AS "candidateName", c.student_id AS "studentId", at.status,
              sub.status AS "submissionStatus",
              (SELECT count(*)::int FROM events e WHERE e.attempt_id = at.id AND e.type = 'recording_stopped') AS stopped
         FROM attempts at
         JOIN exam_assignments a ON a.id = at.assignment_id
         JOIN candidates c ON c.id = a.candidate_id
         LEFT JOIN submissions sub ON sub.attempt_id = at.id
        WHERE a.session_id = $1 AND at.organisation_id = $2
        ORDER BY c.full_name, at.id
        LIMIT 1000`,
      [f.sessionId, auth.organisationId],
    );
    const { rows: pieces } = await db.query<{ attempt_id: string; stream_type: string; pieces: number; bytes: string }>(
      `SELECT rs.attempt_id, rs.stream_type, count(rc.id)::int AS pieces, coalesce(sum(rc.size_bytes), 0)::bigint AS bytes
         FROM recording_streams rs
         JOIN attempts at ON at.id = rs.attempt_id
         JOIN exam_assignments a ON a.id = at.assignment_id
         LEFT JOIN recording_chunks rc ON rc.stream_id = rs.id AND rc.upload_state = 'uploaded'
        WHERE a.session_id = $1
        GROUP BY rs.attempt_id, rs.stream_type`,
      [f.sessionId],
    );
    const items = [];
    for (const a of attempts) {
      const evidence = expected.length ? await evidenceState(db, a.attemptId) : null;
      const streams = Object.fromEntries(
        expected.map((t) => {
          const p = pieces.find((x) => x.attempt_id === a.attemptId && x.stream_type === t);
          return [t, { pieces: p?.pieces ?? 0, bytes: Number(p?.bytes ?? 0), missing: evidence?.missing[t]?.length ?? 0 }];
        }),
      );
      items.push({ ...a, streams, complete: evidence?.complete ?? true, incomplete: evidence?.incomplete ?? [], uncovered: evidence?.uncovered ?? [] });
    }
    if (f.format === 'csv') {
      return sendCsv(
        reply,
        `${fileName(name, 'session')}-recording-health`,
        ['Candidate', 'Student ID', 'Attempt', 'Submission', 'Complete', ...expected.flatMap((t) => [`${t} pieces`, `${t} missing`]), 'Times recording stopped'],
        items.map((r) => [
          r.candidateName,
          r.studentId,
          r.status,
          r.submissionStatus,
          r.complete ? 'yes' : 'no',
          ...expected.flatMap((t) => [r.streams[t]!.pieces, r.streams[t]!.missing]),
          r.stopped,
        ]),
      );
    }
    return {
      expected,
      summary: { attempts: items.length, complete: items.filter((i) => i.complete).length, stopped: items.filter((i) => i.stopped > 0).length },
      items,
    };
  });

  // What each invigilator did: who they watched, how they made contact, and what they recorded.
  app.get('/reports/invigilation', { preHandler: authorize('report:view') }, async (req, reply) => {
    const auth = requireOrg(req);
    const f = parse(sessionFilter, req.query);
    const name = (await sessionName(auth.organisationId, f.sessionId))!;
    const { rows } = await db.query<{
      invigilatorId: string;
      name: string;
      email: string;
      status: string;
      candidates: number;
      watchingNow: number;
      messages: number;
      warnings: number;
      videoCalls: number;
      voiceCalls: number;
      notes: number;
      flags: number;
      extraTime: number;
      ended: number;
      handedOver: number;
      lastSeenAt: Date | null;
    }>(
      `WITH att AS (
         SELECT at.id FROM attempts at JOIN exam_assignments a ON a.id = at.assignment_id WHERE a.session_id = $1
       )
       SELECT i.id AS "invigilatorId", u.display_name AS name, u.email, i.status, i.last_seen_at AS "lastSeenAt",
              (SELECT count(DISTINCT ia.candidate_id)::int FROM invigilation_assignments ia WHERE ia.session_id = $1 AND ia.invigilator_id = i.id) AS candidates,
              (SELECT count(*)::int FROM invigilation_assignments ia WHERE ia.session_id = $1 AND ia.invigilator_id = i.id AND ia.active) AS "watchingNow",
              (SELECT count(*)::int FROM attempt_messages m WHERE m.attempt_id IN (SELECT id FROM att) AND m.sender_user_id = i.user_id AND m.kind = 'message') AS messages,
              (SELECT count(*)::int FROM attempt_messages m WHERE m.attempt_id IN (SELECT id FROM att) AND m.sender_user_id = i.user_id AND m.kind = 'warning') AS warnings,
              (SELECT count(*)::int FROM live_calls lc WHERE lc.attempt_id IN (SELECT id FROM att) AND lc.started_by = i.user_id AND NOT lc.voice) AS "videoCalls",
              (SELECT count(*)::int FROM live_calls lc WHERE lc.attempt_id IN (SELECT id FROM att) AND lc.started_by = i.user_id AND lc.voice) AS "voiceCalls",
              (SELECT count(*)::int FROM events e WHERE e.attempt_id IN (SELECT id FROM att) AND e.invigilator_id = i.id AND e.type = 'invigilator_note') AS notes,
              (SELECT count(*)::int FROM events e WHERE e.attempt_id IN (SELECT id FROM att) AND e.invigilator_id = i.id AND e.type = 'invigilator_flag') AS flags,
              (SELECT count(*)::int FROM events e WHERE e.attempt_id IN (SELECT id FROM att) AND e.invigilator_id = i.id AND e.type = 'time_extended') AS "extraTime",
              (SELECT count(*)::int FROM events e WHERE e.attempt_id IN (SELECT id FROM att) AND e.invigilator_id = i.id AND e.type = 'attempt_ended_by_invigilator') AS ended,
              (SELECT count(*)::int FROM events e WHERE e.attempt_id IN (SELECT id FROM att) AND e.type = 'invigilator_changed' AND e.data->>'from' = i.id::text) AS "handedOver"
         FROM session_invigilators si
         JOIN invigilators i ON i.id = si.invigilator_id
         JOIN users u ON u.id = i.user_id
        WHERE si.session_id = $1
        ORDER BY u.display_name, i.id`,
      [f.sessionId],
    );
    const { rows: unassigned } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM exam_assignments a
        WHERE a.session_id = $1 AND a.status IN ('assigned', 'precheck_complete', 'active')
          AND NOT EXISTS (SELECT 1 FROM invigilation_assignments ia WHERE ia.session_id = a.session_id AND ia.candidate_id = a.candidate_id AND ia.active)`,
      [f.sessionId],
    );
    if (f.format === 'csv') {
      return sendCsv(
        reply,
        `${fileName(name, 'session')}-invigilation`,
        ['Invigilator', 'Email', 'Status', 'Candidates watched', 'Watching now', 'Messages', 'Warnings', 'Video', 'Voice', 'Notes', 'Flags', 'Extra time given', 'Exams ended', 'Handed over', 'Last seen'],
        rows.map((r) => [
          r.name,
          r.email,
          r.status,
          r.candidates,
          r.watchingNow,
          r.messages,
          r.warnings,
          r.videoCalls,
          r.voiceCalls,
          r.notes,
          r.flags,
          r.extraTime,
          r.ended,
          r.handedOver,
          r.lastSeenAt,
        ]),
      );
    }
    return { unassigned: unassigned[0]!.n, items: rows };
  });

  // A session as it stands: who is sitting, who has dropped off, what is still
  // being sent, and incidents from the last few minutes.
  app.get('/reports/session-health', { preHandler: authorize('report:view') }, async (req) => {
    const auth = requireOrg(req);
    const { sessionId } = parse(z.object({ sessionId: z.uuid() }), req.query);
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.status, s.starts_at AS "startsAt", s.ends_at AS "endsAt",
              (SELECT count(*)::int FROM exam_assignments a WHERE a.session_id = s.id AND a.status <> 'revoked') AS assigned,
              (SELECT count(*)::int FROM exam_assignments a WHERE a.session_id = s.id AND a.status = 'precheck_complete') AS ready,
              (SELECT count(*)::int FROM attempts at JOIN exam_assignments a ON a.id = at.assignment_id WHERE a.session_id = s.id AND at.status = 'active') AS sitting,
              (SELECT count(*)::int FROM attempts at JOIN exam_assignments a ON a.id = at.assignment_id
                WHERE a.session_id = s.id AND at.status = 'active' AND at.last_seen_at < now() - make_interval(secs => $3)) AS offline,
              (SELECT count(*)::int FROM attempts at JOIN exam_assignments a ON a.id = at.assignment_id WHERE a.session_id = s.id AND at.status <> 'active') AS submitted,
              (SELECT count(*)::int FROM submissions sub JOIN attempts at ON at.id = sub.attempt_id JOIN exam_assignments a ON a.id = at.assignment_id
                WHERE a.session_id = s.id AND sub.status = 'evidence_pending') AS "evidencePending",
              (SELECT count(*)::int FROM exam_assignments a
                WHERE a.session_id = s.id AND a.status IN ('assigned', 'precheck_complete', 'active')
                  AND NOT EXISTS (SELECT 1 FROM invigilation_assignments ia WHERE ia.session_id = s.id AND ia.candidate_id = a.candidate_id AND ia.active)) AS unwatched,
              (SELECT count(*)::int FROM session_invigilators si JOIN invigilators i ON i.id = si.invigilator_id
                WHERE si.session_id = s.id AND i.status = 'active' AND i.last_seen_at > now() - interval '2 minutes') AS "invigilatorsPresent",
              (SELECT count(*)::int FROM session_invigilators si WHERE si.session_id = s.id) AS "invigilatorsRostered",
              (SELECT count(*)::int FROM events e JOIN attempts at ON at.id = e.attempt_id JOIN exam_assignments a ON a.id = at.assignment_id
                WHERE a.session_id = s.id AND e.severity = 'high' AND e.occurred_at > now() - make_interval(mins => $4)) AS "recentIncidents"
         FROM sessions s WHERE s.id = $1 AND s.organisation_id = $2`,
      [sessionId, auth.organisationId, ONLINE_SECONDS, RECENT_INCIDENT_MINUTES],
    );
    if (!rows[0]) throw notFound('Session');
    return { ...rows[0], recentIncidentMinutes: RECENT_INCIDENT_MINUTES };
  });

  // The organisation over a period: sessions, completion, results and technical events.
  app.get('/reports/organisation', { preHandler: authorize('report:view') }, async (req) => {
    const auth = requireOrg(req);
    const f = parse(filters.pick({ from: true, to: true }), req.query);
    const range = [auth.organisationId, f.from ?? null, f.to ?? null];
    const inRange = (col: string) => `($2::timestamptz IS NULL OR ${col} >= $2) AND ($3::timestamptz IS NULL OR ${col} <= $3)`;
    const one = async <T>(sql: string) => (await db.query(sql, range)).rows[0] as T;
    const [sessions, attempts, results] = await Promise.all([
      one<{ total: number; open: number; closed: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'closed')::int AS closed
           FROM sessions WHERE organisation_id = $1 AND ${inRange('starts_at')}`,
      ),
      one<{ started: number; submitted: number; byTimer: number; bySystem: number; byInvigilator: number }>(
        `SELECT count(*)::int AS started, count(*) FILTER (WHERE status <> 'active')::int AS submitted,
                count(*) FILTER (WHERE submitted_by = 'timer')::int AS "byTimer",
                count(*) FILTER (WHERE submitted_by = 'system')::int AS "bySystem",
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.attempt_id = attempts.id AND e.type = 'attempt_ended_by_invigilator'))::int AS "byInvigilator"
           FROM attempts WHERE organisation_id = $1 AND ${inRange('started_at')}`,
      ),
      one<{ pending: number; marked: number; released: number; averagePercent: number | null }>(
        `SELECT count(*) FILTER (WHERE r.status = 'pending')::int AS pending,
                count(*) FILTER (WHERE r.status IN ('marked', 'moderated'))::int AS marked,
                count(*) FILTER (WHERE r.status = 'released')::int AS released,
                round(avg(100.0 * r.score / nullif(r.max_score, 0)) FILTER (WHERE r.status = 'released'), 1)::float AS "averagePercent"
           FROM results r JOIN attempts at ON at.id = r.attempt_id WHERE r.organisation_id = $1 AND ${inRange('at.started_at')}`,
      ),
    ]);
    const { rows: candidates } = await db.query<{ status: string; count: number }>(
      'SELECT status, count(*)::int AS count FROM candidates WHERE organisation_id = $1 GROUP BY status ORDER BY status',
      [auth.organisationId],
    );
    const { rows: events } = await db.query<{ type: string; severity: string; count: number; counted: boolean }>(
      `SELECT e.type, e.severity, count(*)::int AS count, e.type = ANY($4::text[]) AS counted
         FROM events e WHERE e.organisation_id = $1 AND e.severity <> 'info' AND ${inRange('e.occurred_at')}
        GROUP BY e.type, e.severity ORDER BY count DESC LIMIT 20`,
      [...range, COUNTED_EVENT_TYPES],
    );
    return {
      from: f.from ?? null,
      to: f.to ?? null,
      sessions,
      attempts: { ...attempts, completionPercent: percent(attempts.submitted, attempts.started) },
      results,
      candidates: Object.fromEntries(candidates.map((c) => [c.status, c.count])),
      technicalEvents: events,
    };
  });

  // Everything about one attempt in one place (spec section 18, candidate
  // attempt report): who, which exam, when, the answers and marks, the
  // submission and its evidence, and the timeline.
  app.get('/attempts/:id/report', { preHandler: authorize('report:view') }, async (req) => {
    const auth = requireOrg(req);
    const { id } = parse(idParams, req.params);
    const { rows } = await db.query<Record<string, unknown> & { status: string }>(
      `SELECT at.id AS "attemptId", at.status, at.started_at AS "startedAt", at.deadline_at AS "deadlineAt",
              at.submitted_at AS "submittedAt", at.submitted_by AS "submittedBy",
              json_build_object('id', c.id, 'fullName', c.full_name, 'studentId', c.student_id, 'email', c.email,
                                'status', c.status, 'identityStatus', c.identity_status) AS candidate,
              json_build_object('name', v.manifest->>'name', 'code', v.manifest->>'code', 'version', v.version, 'manifestSha256', v.manifest_sha256) AS exam,
              json_build_object('id', s.id, 'name', s.name, 'startsAt', s.starts_at, 'endsAt', s.ends_at) AS session,
              a.extra_minutes AS "extraMinutes",
              sub.status AS "submissionStatus", sub.package_sha256 AS "packageSha256", sub.verified_at AS "verifiedAt",
              r.status AS "resultStatus", r.released_at AS "releasedAt"
         FROM attempts at
         JOIN exam_assignments a ON a.id = at.assignment_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN sessions s ON s.id = a.session_id
         JOIN exam_versions v ON v.id = at.exam_version_id
         LEFT JOIN submissions sub ON sub.attempt_id = at.id
         LEFT JOIN results r ON r.attempt_id = at.id
        WHERE at.id = $1 AND at.organisation_id = $2`,
      [id, auth.organisationId],
    );
    const row = rows[0];
    if (!row) throw notFound('Attempt');
    const input = await loadMarkingInput(db, id);
    const mark = markFrom(input);
    const byId = new Map(mark.questions.map((q) => [q.questionId, q]));
    const { rows: timeline } = await db.query(
      `SELECT e.type, e.severity, e.occurred_at AS "occurredAt", e.data - 'byUserId' AS data, coalesce(u.display_name, bu.display_name) AS "by"
         FROM events e LEFT JOIN invigilators i ON i.id = e.invigilator_id LEFT JOIN users u ON u.id = i.user_id
         ${BY_USER}
        WHERE e.attempt_id = $1 ORDER BY e.occurred_at, e.seq`,
      [id],
    );
    const offline = timeline.filter((e) => OFFLINE_TYPES.includes(e.type as string));
    await withTransaction(db, (tx) => audit(tx, { ...auditFrom(req), action: 'report.attempt', targetType: 'attempt', targetId: id }));
    return {
      ...row,
      score: row.status === 'active' ? null : mark.score,
      maxScore: mark.maxScore,
      percent: row.status === 'active' ? null : percent(mark.score, mark.maxScore),
      needsManual: mark.needsManual,
      answers: input.questions.map((q) => {
        const m = byId.get(q.id);
        const answer = input.answers.get(q.id) ?? null;
        return {
          questionId: q.id,
          type: q.type,
          prompt: q.prompt,
          answer: answer && (answer.optionId || answer.optionIds)
            ? { choices: q.options.filter((o) => o.id === answer.optionId || answer.optionIds?.includes(o.id)).map((o) => o.label) }
            : answer,
          awarded: m?.awarded ?? null,
          maxPoints: m?.maxPoints ?? q.points,
        };
      }),
      evidence: row.status === 'active' ? null : await evidenceState(db, id),
      offline: {
        interruptions: offline.length,
        totalSeconds: offline.reduce((n, e) => n + Number((e.data as { offlineSeconds?: number }).offlineSeconds ?? 0), 0),
      },
      timeline,
    };
  });
}
