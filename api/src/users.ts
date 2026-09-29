import { hashPassword } from './auth/passwords.js';
import { badRequest } from './errors.js';
import type { Queryable } from './db.js';

/**
 * Returns the existing user with this email, or creates one. Existing users
 * keep their password; a password is required only when creating.
 */
export async function findOrCreateUser(
  q: Queryable,
  input: { email: string; displayName: string; password?: string | undefined },
): Promise<{ id: string; created: boolean }> {
  const { rows } = await q.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [input.email]);
  if (rows[0]) return { id: rows[0].id, created: false };
  if (!input.password) throw badRequest('A password is required for a new user');

  const { rows: created } = await q.query<{ id: string }>(
    'INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [input.email, input.displayName, await hashPassword(input.password)],
  );
  return { id: created[0]!.id, created: true };
}

export async function roleIdByKey(q: Queryable, organisationId: string, key: string): Promise<string> {
  // An organisation-specific role overrides the platform template with the same key.
  const { rows } = await q.query<{ id: string }>(
    `SELECT id FROM roles
      WHERE key = $2 AND (organisation_id = $1 OR organisation_id IS NULL)
      ORDER BY organisation_id NULLS LAST LIMIT 1`,
    [organisationId, key],
  );
  if (!rows[0]) throw badRequest(`Unknown role: ${key}`);
  return rows[0].id;
}
