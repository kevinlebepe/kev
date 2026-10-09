import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, onIdleError?: (err: Error) => void): Db {
  const pool = new pg.Pool({ connectionString, max: 20 });
  // An idle connection dropped by the server (failover, restart, admin
  // termination) is emitted here. Without a listener Node treats it as an
  // unhandled error and kills the process; the pool replaces the connection
  // on the next query instead (spec section 17).
  pool.on('error', onIdleError ?? ((err) => console.error('Idle database connection lost:', err.message)));
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

export function isConstraint(err: unknown, constraint: string): boolean {
  return (err as { constraint?: string })?.constraint === constraint;
}
