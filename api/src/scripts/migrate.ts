import { createPool } from '../db.js';
import { migrate } from '../migrate.js';

const db = createPool(process.env.DATABASE_URL ?? 'postgres://examguard:examguard@localhost:5432/examguard');
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
} finally {
  await db.end();
}
