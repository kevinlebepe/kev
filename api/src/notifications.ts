import type { Queryable } from './db.js';

export interface NotificationInput {
  organisationId: string | null;
  kind: string;
  channel?: 'in_app' | 'email';
  recipientUserId?: string | null;
  recipientEmail?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Notifications are written to an outbox table in the caller's transaction; a
 * worker delivers email (spec sections 14, 20). Exam controls never depend on
 * the email actually arriving.
 */
export async function notify(q: Queryable, n: NotificationInput): Promise<void> {
  await q.query(
    `INSERT INTO notifications (organisation_id, kind, channel, recipient_user_id, recipient_email, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [n.organisationId, n.kind, n.channel ?? 'in_app', n.recipientUserId ?? null, n.recipientEmail ?? null, n.payload ?? {}],
  );
}
