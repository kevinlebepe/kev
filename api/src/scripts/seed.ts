// Creates the first platform super admin. Further organisations are created
// via POST /platform/organisations.
//
// It can also create the first organisation and its owner, so a new
// deployment needs no commands at all: set ORGANISATION_SLUG,
// ORGANISATION_NAME, OWNER_EMAIL and OWNER_PASSWORD (and optionally
// OWNER_NAME and ORGANISATION_MODE). Safe to run on every start: an
// organisation that already exists is left as it is.
import { hashPassword } from '../auth/passwords.js';
import { audit } from '../audit.js';
import { createPool, withTransaction } from '../db.js';
import { findOrCreateUser, roleIdByKey } from '../users.js';

const email = process.env.SUPER_ADMIN_EMAIL;
const password = process.env.SUPER_ADMIN_PASSWORD;
if (!email || !password || password.length < 12) {
  console.error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (12+ characters).');
  process.exit(1);
}

const MODES = ['university', 'school', 'employer', 'recruitment_agency', 'certification', 'other'];
const slug = process.env.ORGANISATION_SLUG?.trim().toLowerCase();
const orgName = process.env.ORGANISATION_NAME?.trim();
const ownerEmail = process.env.OWNER_EMAIL?.trim();
const ownerPassword = process.env.OWNER_PASSWORD;
const ownerName = process.env.OWNER_NAME?.trim() || 'Owner';
const mode = process.env.ORGANISATION_MODE?.trim() || 'other';

const db = createPool(process.env.DATABASE_URL ?? 'postgres://examguard:examguard@localhost:5432/examguard');
try {
  await db.query(
    `INSERT INTO users (email, display_name, password_hash, platform_role)
     VALUES ($1, 'Platform Admin', $2, 'super_admin')
     ON CONFLICT (lower(email)) DO UPDATE SET platform_role = 'super_admin'`,
    [email, await hashPassword(password)],
  );
  console.log(`Super admin ready: ${email}`);

  if (slug) {
    const problems = [
      !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug) && 'ORGANISATION_SLUG may only use lower case letters, numbers and dashes',
      !orgName && 'ORGANISATION_NAME is missing',
      !ownerEmail?.includes('@') && 'OWNER_EMAIL is missing',
      (!ownerPassword || ownerPassword.length < 12) && 'OWNER_PASSWORD needs 12 or more characters',
      !MODES.includes(mode) && `ORGANISATION_MODE must be one of ${MODES.join(', ')}`,
    ].filter(Boolean);
    if (problems.length) {
      // Reported, not fatal: the platform itself still starts.
      console.error(`Organisation not created: ${problems.join('; ')}.`);
    } else {
      const created = await withTransaction(db, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO organisations (slug, name, mode, approved_email_domains) VALUES ($1, $2, $3, '{}')
           ON CONFLICT (slug) DO NOTHING RETURNING id`,
          [slug, orgName, mode],
        );
        if (!rows[0]) return false;
        const organisationId = rows[0].id;
        const owner = await findOrCreateUser(tx, { email: ownerEmail!, displayName: ownerName, password: ownerPassword });
        await tx.query('INSERT INTO organisation_users (organisation_id, user_id, role_id) VALUES ($1, $2, $3)', [
          organisationId,
          owner.id,
          await roleIdByKey(tx, organisationId, 'owner'),
        ]);
        await audit(tx, { organisationId, actorUserId: null, action: 'organisation.create', targetType: 'organisation', targetId: organisationId, data: { slug, by: 'seed' } });
        return true;
      });
      console.log(created ? `Organisation ready: ${slug}, owner ${ownerEmail}` : `Organisation ${slug} already exists; left as it is.`);
    }
  }
} finally {
  await db.end();
}
