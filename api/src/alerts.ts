import type { Db, Queryable } from './db.js';
import { withTransaction } from './db.js';
import { notify } from './notifications.js';

// Reminders and alerts (spec section 20). In app notifications carry
// immediate events for staff; email carries scheduled and administrative
// messages. Exam controls never wait on either.

/** When candidates who have not run the device check are reminded. */
export const PRECHECK_REMINDER_HOURS = 72;
/** When candidates and invigilators are told the exam is about to start. */
export const START_REMINDER_MINUTES = 60;
/** How long after submission missing recordings are reported to staff. */
export const EVIDENCE_ALERT_HOURS = 24;

/** Active staff of an organisation who hold a permission. */
export async function staffWith(q: Queryable, organisationId: string, permission: string): Promise<{ id: string; email: string }[]> {
  const { rows } = await q.query<{ id: string; email: string }>(
    `SELECT DISTINCT u.id, u.email
       FROM organisation_users ou
       JOIN role_permissions rp ON rp.role_id = ou.role_id AND rp.permission_key = $2
       JOIN users u ON u.id = ou.user_id
      WHERE ou.organisation_id = $1 AND ou.status = 'active'
      ORDER BY u.id`,
    [organisationId, permission],
  );
  return rows;
}

/** Notifies every member of staff with a permission in app, and by email as well when asked. */
export async function notifyStaff(
  q: Queryable,
  n: { organisationId: string; permission: string; kind: string; payload: Record<string, unknown>; email?: boolean },
): Promise<number> {
  const staff = await staffWith(q, n.organisationId, n.permission);
  for (const s of staff) {
    await notify(q, { organisationId: n.organisationId, kind: n.kind, recipientUserId: s.id, payload: n.payload });
    if (n.email) await notify(q, { organisationId: n.organisationId, kind: n.kind, channel: 'email', recipientUserId: s.id, payload: n.payload });
  }
  return staff.length;
}

/** A short title and line for an in app notification. */
export function summarise(kind: string, payload: Record<string, unknown>, sessionName: string | null): { title: string; body: string } {
  const session = sessionName ?? 'a session';
  const n = (key: string) => Number(payload[key] ?? 0);
  switch (kind) {
    case 'invigilator_capacity_alert':
      return { title: 'Invigilators are full', body: `${n('unassigned')} candidates in ${session} are waiting for an invigilator. Add an invigilator or raise a limit.` };
    case 'readiness_failure':
      return { title: 'A device check failed', body: `${String(payload.candidateName ?? 'A candidate')} failed the device check for ${session}: ${(payload.failed as string[] | undefined)?.join(', ') ?? ''}.` };
    case 'candidate_offline':
      return {
        title: 'A candidate was offline too long',
        body: `${String(payload.candidateName ?? 'A candidate')} in ${session} was offline for ${Math.round(n('offlineSeconds') / 60)} minutes, past the exam's limit.`,
      };
    case 'evidence_incomplete':
      return { title: 'Recordings are missing', body: `${n('attempts')} submissions in ${session} are still missing recording pieces a day after the exam.` };
    case 'service_incident':
      return { title: 'Service problem', body: String(payload.message ?? 'Part of the platform is not working.') };
    default:
      return { title: kind.replaceAll('_', ' '), body: '' };
  }
}

/**
 * Sends reminders that have come due and raises alerts for evidence still
 * missing. Safe on every instance: each row is claimed with SKIP LOCKED and
 * stamped in the same transaction as its notification.
 */
export async function sendReminders(db: Db): Promise<{ precheck: number; start: number; invigilators: number; evidence: number }> {
  return withTransaction(db, async (tx) => {
    // Candidates who have not yet passed the device check, three days out.
    const { rows: precheck } = await tx.query<{ id: string; organisation_id: string; session_id: string; user_id: string | null; email: string }>(
      `SELECT a.id, a.organisation_id, a.session_id, c.user_id, c.email
         FROM exam_assignments a JOIN sessions s ON s.id = a.session_id JOIN candidates c ON c.id = a.candidate_id
        WHERE a.status = 'assigned' AND a.precheck_reminded_at IS NULL AND c.status = 'approved'
          AND s.status IN ('scheduled', 'open') AND s.starts_at > now() AND s.starts_at < now() + make_interval(hours => $1)
        LIMIT 200 FOR UPDATE OF a SKIP LOCKED`,
      [PRECHECK_REMINDER_HOURS],
    );
    for (const r of precheck) {
      await notify(tx, { organisationId: r.organisation_id, kind: 'precheck_reminder', channel: 'email', recipientUserId: r.user_id, recipientEmail: r.email, payload: { sessionId: r.session_id } });
      await tx.query('UPDATE exam_assignments SET precheck_reminded_at = now() WHERE id = $1', [r.id]);
    }

    // Everyone still due to sit, an hour before the start.
    const { rows: start } = await tx.query<{ id: string; organisation_id: string; session_id: string; user_id: string | null; email: string; ready: boolean }>(
      `SELECT a.id, a.organisation_id, a.session_id, c.user_id, c.email, a.status = 'precheck_complete' AS ready
         FROM exam_assignments a JOIN sessions s ON s.id = a.session_id JOIN candidates c ON c.id = a.candidate_id
        WHERE a.status IN ('assigned', 'precheck_complete') AND a.start_reminded_at IS NULL AND c.status = 'approved'
          AND s.status IN ('scheduled', 'open') AND s.starts_at > now() AND s.starts_at < now() + make_interval(mins => $1)
        LIMIT 200 FOR UPDATE OF a SKIP LOCKED`,
      [START_REMINDER_MINUTES],
    );
    for (const r of start) {
      await notify(tx, {
        organisationId: r.organisation_id,
        kind: 'exam_starting_soon',
        channel: 'email',
        recipientUserId: r.user_id,
        recipientEmail: r.email,
        payload: { sessionId: r.session_id, ready: r.ready },
      });
      await tx.query('UPDATE exam_assignments SET start_reminded_at = now() WHERE id = $1', [r.id]);
    }

    // The session's invigilators, at the same time.
    const { rows: sessions } = await tx.query<{ id: string; organisation_id: string }>(
      `SELECT s.id, s.organisation_id FROM sessions s
        WHERE s.invigilators_reminded_at IS NULL AND s.status IN ('scheduled', 'open')
          AND s.starts_at > now() AND s.starts_at < now() + make_interval(mins => $1)
        LIMIT 50 FOR UPDATE SKIP LOCKED`,
      [START_REMINDER_MINUTES],
    );
    let invigilators = 0;
    for (const s of sessions) {
      const { rows: people } = await tx.query<{ user_id: string }>(
        `SELECT i.user_id FROM session_invigilators si JOIN invigilators i ON i.id = si.invigilator_id
          WHERE si.session_id = $1 AND i.status = 'active'`,
        [s.id],
      );
      for (const p of people) {
        await notify(tx, { organisationId: s.organisation_id, kind: 'invigilator_session_starting', channel: 'email', recipientUserId: p.user_id, payload: { sessionId: s.id } });
        invigilators += 1;
      }
      await tx.query('UPDATE sessions SET invigilators_reminded_at = now() WHERE id = $1', [s.id]);
    }

    // Submissions still waiting for recordings a day on: one alert per session.
    const { rows: pending } = await tx.query<{ id: string; organisation_id: string; session_id: string }>(
      `SELECT sub.id, sub.organisation_id, a.session_id
         FROM submissions sub JOIN attempts at ON at.id = sub.attempt_id JOIN exam_assignments a ON a.id = at.assignment_id
        WHERE sub.status = 'evidence_pending' AND sub.evidence_alerted_at IS NULL
          AND sub.received_at < now() - make_interval(hours => $1)
        LIMIT 500 FOR UPDATE OF sub SKIP LOCKED`,
      [EVIDENCE_ALERT_HOURS],
    );
    const bySession = new Map<string, { organisationId: string; ids: string[] }>();
    for (const p of pending) {
      const entry = bySession.get(p.session_id) ?? { organisationId: p.organisation_id, ids: [] };
      entry.ids.push(p.id);
      bySession.set(p.session_id, entry);
    }
    for (const [sessionId, e] of bySession) {
      await notifyStaff(tx, {
        organisationId: e.organisationId,
        permission: 'session:manage',
        kind: 'evidence_incomplete',
        payload: { sessionId, attempts: e.ids.length },
        email: true,
      });
      await tx.query('UPDATE submissions SET evidence_alerted_at = now() WHERE id = ANY($1::uuid[])', [e.ids]);
    }

    return { precheck: precheck.length, start: start.length, invigilators, evidence: pending.length };
  });
}
