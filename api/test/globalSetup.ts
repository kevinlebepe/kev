import pg from 'pg';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://examguard:examguard@localhost:5432/examguard_test';

// Recreate the test database from scratch so every run exercises the migrations.
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const db = createPool(TEST_DATABASE_URL);
  await migrate(db);
  await db.end();
}
