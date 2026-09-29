import nodemailer from 'nodemailer';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { withTransaction } from './db.js';

// Delivers email from the notifications outbox. Notifications are written in
// the same transaction as the change that caused them, so an email is never
// sent for something that was rolled back, and a crash never loses one.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/** Sends through an SMTP server, for example smtps://user:pass@smtp.example.com:465. */
export function smtpTransport(url: string, from: string): MailTransport {
  const transporter = nodemailer.createTransport(url);
  return {
    async send(m) {
      await transporter.sendMail({ from, to: m.to, subject: m.subject, text: m.text });
    },
  };
}

/** Development only: prints each email, links included, so the flow can be tried without a mail server. */
export function logTransport(log: (line: string) => void): MailTransport {
  return {
    async send(m) {
      log(`\n--- Email to ${m.to} ---\nSubject: ${m.subject}\n\n${m.text}\n--- End of email ---`);
    },
  };
}

interface Row {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  to: string | null;
  organisation_name: string | null;
  session_name: string | null;
  starts_at: Date | null;
}

const when = new Intl.DateTimeFormat('en-ZA', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Africa/Johannesburg' });

/** The email for each kind of notification. Kinds without one are left for in app delivery. */
export function render(row: Row, config: Config): Omit<MailMessage, 'to'> | null {
  const org = row.organisation_name ?? 'your organisation';
  const link = typeof row.payload.link === 'string' ? row.payload.link : null;
  const signIn = `Sign in at ${config.publicBaseUrl}`;
  const footer = `\n\nThis message was sent by ExamGuard on behalf of ${org}. If you were not expecting it, you can ignore it.`;
  switch (row.kind) {
    case 'candidate_invitation':
      if (!link) return null;
      return {
        subject: `${org} invites you to write exams with ExamGuard`,
        text: `Hello ${String(row.payload.fullName ?? '')}\n\n${org} has invited you to write exams with ExamGuard.\n\nSet your password here:\n${link}\n\nThe link can be used once and expires in ${config.invitationTtlHours / 24} days. After you accept, ${org} approves your account before any exam is assigned.${footer}`,
      };
    case 'candidate_email_verification':
      if (!link) return null;
      return {
        subject: 'Confirm your email address for ExamGuard',
        text: `Hello\n\nConfirm your email address to finish registering with ${org}:\n${link}\n\nThe link can be used once.${footer}`,
      };
    case 'exam_assigned':
      return {
        subject: `New exam: ${row.session_name ?? 'exam session'}`,
        text: `Hello\n\n${org} has assigned you an exam: ${row.session_name ?? 'an exam session'}${row.starts_at ? `, starting ${when.format(row.starts_at)} (South African time)` : ''}.\n\n${signIn}, open the exam and run the device check well before exam day, on the device you will use.${footer}`,
      };
    case 'result_released':
      return {
        subject: `Your result is available: ${row.session_name ?? 'exam'}`,
        text: `Hello\n\n${org} has released your result for ${row.session_name ?? 'your exam'}.\n\n${signIn} and look under My results.${footer}`,
      };
    case 'candidate_verification_requested':
      return {
        subject: `${org} needs to verify your identity`,
        text: `Hello\n\n${org} needs to verify your identity before approving your account.\n\n${String(row.payload.message ?? '')}\n\nReply to your organisation's exam support with what they ask for.${footer}`,
      };
    default:
      return null;
  }
}

export const MAX_ATTEMPTS = 8;

/**
 * Sends due emails. Safe to run on every API instance at once: each row is
 * locked while it is sent. The link is removed from the stored payload after
 * sending, because it holds a live single use token.
 */
export async function deliverEmails(db: Db, config: Config, transport: MailTransport, limit = 20): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const outcome = await withTransaction(db, async (tx) => {
      const { rows } = await tx.query<Row>(
        `SELECT n.id, n.kind, n.payload, coalesce(n.recipient_email, u.email) AS to,
                o.name AS organisation_name, s.name AS session_name, s.starts_at
           FROM notifications n
           LEFT JOIN users u ON u.id = n.recipient_user_id
           LEFT JOIN organisations o ON o.id = n.organisation_id
           LEFT JOIN sessions s ON s.id::text = n.payload->>'sessionId' AND s.organisation_id = n.organisation_id
          WHERE n.channel = 'email' AND n.sent_at IS NULL AND n.failed_at IS NULL
            -- Back off after a failure: 1, 2, 4 ... minutes.
            AND (n.attempts = 0 OR n.created_at + make_interval(mins => power(2, n.attempts)::int) < now())
          ORDER BY n.created_at
          LIMIT 1
          FOR UPDATE OF n SKIP LOCKED`,
      );
      const row = rows[0];
      if (!row) return 'empty' as const;
      const message = render(row, config);
      if (!message || !row.to) {
        await tx.query(`UPDATE notifications SET failed_at = now(), last_error = $2, payload = payload - 'link' WHERE id = $1`, [
          row.id,
          !row.to ? 'No recipient address' : `No email template for ${row.kind}`,
        ]);
        return 'failed' as const;
      }
      try {
        await transport.send({ to: row.to, ...message });
      } catch (err) {
        const attempts = await tx.query<{ attempts: number }>(
          `UPDATE notifications SET attempts = attempts + 1, last_error = $2,
                  failed_at = CASE WHEN attempts + 1 >= $3 THEN now() END,
                  payload = CASE WHEN attempts + 1 >= $3 THEN payload - 'link' ELSE payload END
            WHERE id = $1 RETURNING attempts`,
          [row.id, String((err as Error).message).slice(0, 500), MAX_ATTEMPTS],
        );
        return attempts.rows[0]!.attempts >= MAX_ATTEMPTS ? ('failed' as const) : ('retry' as const);
      }
      await tx.query(`UPDATE notifications SET sent_at = now(), attempts = attempts + 1, last_error = NULL, payload = payload - 'link' WHERE id = $1`, [row.id]);
      return 'sent' as const;
    });
    if (outcome === 'empty') break;
    if (outcome === 'sent') sent += 1;
    if (outcome === 'failed') failed += 1;
  }
  return { sent, failed };
}
