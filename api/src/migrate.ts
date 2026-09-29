import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { type Db, withTransaction } from './db.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

// Forward-only, transactional migrations. Each file runs once, in name order.
export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  for (const name of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    const ran = await withTransaction(db, async (tx) => {
      // Serialise concurrent migrators (e.g. several API instances booting).
      await tx.query('SELECT pg_advisory_xact_lock(7349201)');
      const { rowCount } = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (rowCount) return false;
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      return true;
    });
    if (ran) applied.push(name);
  }
  return applied;
}
