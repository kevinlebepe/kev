import type { Db } from './db.js';
import { withTransaction } from './db.js';
import { allocate, PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR } from './allocation.js';
import { audit } from './audit.js';

// Automatic invigilator failover (spec sections 7 and 8). An invigilator who
// is paused, suspended, or has not had the live console open for a while
// no longer watches anyone: their candidates move to rostered invigilators
// who are present and have room. When nobody has room, a candidate stays
// where they are rather than being left with no invigilator at all.

/** An invigilator whose console has not checked in for this long counts as gone. */
export const ABSENT_AFTER_SECONDS = 120;
/** How long after a session starts an invigilator who never opened the console is treated as gone. */
export const NO_SHOW_AFTER_SECONDS = 300;

const PRESENT = `i.status = 'active' AND i.last_seen_at > now() - make_interval(secs => ${ABSENT_AFTER_SECONDS})`;

export interface FailoverResult {
  moved: { candidateId: string; from: string; to: string }[];
  stranded: string[];
}

export async function failoverSession(db: Db, sessionId: string): Promise<FailoverResult> {
  return withTransaction(db, async (tx) => {
    // The same lock order as manual allocation: session, then invigilators by id.
    const { rows: session } = await tx.query<{ organisation_id: string; cap: number | null; started_for: number }>(
      `SELECT s.organisation_id, (v.manifest #>> '{config,invigilation,maxCandidatesPerInvigilator}')::int AS cap,
              extract(epoch FROM now() - s.starts_at)::int AS started_for
         FROM sessions s JOIN exam_versions v ON v.id = s.exam_version_id
        WHERE s.id = $1 AND s.status = 'open' FOR UPDATE OF s`,
      [sessionId],
    );
    if (!session[0]) return { moved: [], stranded: [] };
    const { organisation_id: organisationId, cap, started_for: startedFor } = session[0];
    await tx.query(
      `SELECT i.id FROM invigilators i JOIN session_invigilators si ON si.invigilator_id = i.id AND si.session_id = $1
        ORDER BY i.id FOR UPDATE OF i`,
      [sessionId],
    );

    const { rows: orphans } = await tx.query<{ id: string; candidate_id: string; invigilator_id: string }>(
      `SELECT ia.id, ia.candidate_id, ia.invigilator_id
         FROM invigilation_assignments ia
         JOIN invigilators i ON i.id = ia.invigilator_id
         JOIN exam_assignments a ON a.session_id = ia.session_id AND a.candidate_id = ia.candidate_id
        WHERE ia.session_id = $1 AND ia.active
          AND a.status IN ('assigned', 'precheck_complete', 'active')
          AND (i.status <> 'active'
               OR i.last_seen_at < now() - make_interval(secs => $2)
               OR (i.last_seen_at IS NULL AND $3::int > $4::int))
        ORDER BY ia.assigned_at, ia.candidate_id`,
      [sessionId, ABSENT_AFTER_SECONDS, startedFor, NO_SHOW_AFTER_SECONDS],
    );
    if (!orphans.length) return { moved: [], stranded: [] };

    const { rows: present } = await tx.query<{ id: string; capacity: number; load: number }>(
      `SELECT i.id, i.max_active AS capacity,
              (SELECT count(*)::int FROM invigilation_assignments ia WHERE ia.invigilator_id = i.id AND ia.active) AS load
         FROM invigilators i JOIN session_invigilators si ON si.invigilator_id = i.id AND si.session_id = $1
        WHERE ${PRESENT}
        ORDER BY i.id`,
      [sessionId],
    );
    const plan = allocate(
      orphans.map((o) => o.candidate_id),
      present,
      { sessionCap: cap ?? PLATFORM_MAX_CANDIDATES_PER_INVIGILATOR },
    );

    const byCandidate = new Map(orphans.map((o) => [o.candidate_id, o]));
    const moved: FailoverResult['moved'] = [];
    for (const a of plan.assignments) {
      const old = byCandidate.get(a.candidateId)!;
      await tx.query(`UPDATE invigilation_assignments SET active = false, released_at = now() WHERE id = $1`, [old.id]);
      await tx.query(
        `INSERT INTO invigilation_assignments (organisation_id, session_id, invigilator_id, candidate_id) VALUES ($1, $2, $3, $4)`,
        [organisationId, sessionId, a.invigilatorId, a.candidateId],
      );
      await tx.query(
        `INSERT INTO events (organisation_id, attempt_id, invigilator_id, type, severity, occurred_at, data)
         SELECT $1, at.id, $4, 'invigilator_changed', 'info', date_trunc('milliseconds', now()), jsonb_build_object('from', $3::text, 'reason', 'failover')
           FROM attempts at JOIN exam_assignments ea ON ea.id = at.assignment_id
          WHERE ea.session_id = $2 AND ea.candidate_id = $5`,
        [organisationId, sessionId, old.invigilator_id, a.invigilatorId, a.candidateId],
      );
      moved.push({ candidateId: a.candidateId, from: old.invigilator_id, to: a.invigilatorId });
    }
    await audit(tx, {
      organisationId,
      actorUserId: null,
      action: 'invigilation.failover',
      targetType: 'session',
      targetId: sessionId,
      data: { moved: moved.length, stranded: plan.unassigned.length },
    });
    return { moved, stranded: plan.unassigned };
  });
}

/** Runs failover for every open session that needs it. Safe on several instances: sessions are locked. */
export async function runFailover(db: Db): Promise<number> {
  const { rows } = await db.query<{ session_id: string }>(
    `SELECT DISTINCT ia.session_id
       FROM invigilation_assignments ia
       JOIN invigilators i ON i.id = ia.invigilator_id
       JOIN sessions s ON s.id = ia.session_id AND s.status = 'open'
      WHERE ia.active
        AND (i.status <> 'active'
             OR i.last_seen_at < now() - make_interval(secs => $1)
             OR (i.last_seen_at IS NULL AND s.starts_at < now() - make_interval(secs => $2)))
      LIMIT 100`,
    [ABSENT_AFTER_SECONDS, NO_SHOW_AFTER_SECONDS],
  );
  let moved = 0;
  for (const r of rows) moved += (await failoverSession(db, r.session_id)).moved.length;
  return moved;
}
