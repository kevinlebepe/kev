import type { Config } from './config.js';
import type { Queryable } from './db.js';
import { badRequest } from './errors.js';
import { hashToken, newOpaqueToken } from './auth/passwords.js';
import { notify } from './notifications.js';

// Single use emailed links for staff invitations and password resets. Only
// the hash is stored, so a copy of the database cannot be used to sign in.

export type UserTokenPurpose = 'staff_invitation' | 'password_reset';

export const PASSWORD_RESET_TTL_HOURS = 1;

export async function issueUserToken(q: Queryable, userId: string, purpose: UserTokenPurpose, ttlHours: number): Promise<string> {
  const { token, hash } = newOpaqueToken();
  // A new link replaces any earlier one for the same purpose.
  await q.query(`UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await q.query(
    `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [userId, purpose, hash, ttlHours],
  );
  return token;
}

/** Uses a link once. Locks the row, so two uses at the same moment cannot both succeed. */
export async function consumeUserToken(q: Queryable, token: string, purpose: UserTokenPurpose): Promise<string> {
  const { rows } = await q.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM user_tokens
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
    [hashToken(token), purpose],
  );
  if (!rows[0]) throw badRequest('This link is invalid or has expired');
  await q.query('UPDATE user_tokens SET used_at = now() WHERE id = $1', [rows[0].id]);
  return rows[0].user_id;
}

/** Emails a new staff member a link to choose their password. */
export async function inviteStaff(
  q: Queryable,
  config: Config,
  input: { userId: string; email: string; organisationId: string; role: string },
): Promise<void> {
  const token = await issueUserToken(q, input.userId, 'staff_invitation', config.invitationTtlHours);
  await notify(q, {
    organisationId: input.organisationId,
    kind: 'staff_invitation',
    channel: 'email',
    recipientUserId: input.userId,
    recipientEmail: input.email,
    payload: { link: `${config.portalBaseUrl}/#/invitation/${token}`, role: input.role },
  });
}
