// Creates the first platform super admin. Organisations are then created via
// POST /platform/organisations.
import { hashPassword } from '../auth/passwords.js';
import { createPool } from '../db.js';

const email = process.env.SUPER_ADMIN_EMAIL;
const password = process.env.SUPER_ADMIN_PASSWORD;
if (!email || !password || password.length < 12) {
  console.error('Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (12+ characters).');
  process.exit(1);
}

const db = createPool(process.env.DATABASE_URL ?? 'postgres://examguard:examguard@localhost:5432/examguard');
try {
  await db.query(
    `INSERT INTO users (email, display_name, password_hash, platform_role)
     VALUES ($1, 'Platform Admin', $2, 'super_admin')
     ON CONFLICT (lower(email)) DO UPDATE SET platform_role = 'super_admin'`,
    [email, await hashPassword(password)],
  );
  console.log(`Super admin ready: ${email}`);
} finally {
  await db.end();
}
