import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { TEST_DATABASE_URL } from './globalSetup.js';
import { call, createOrg, useHarness } from './helpers.js';

const h = useHarness();

// Spec section 17: a database failover must not take API instances down.
describe('database connection loss', () => {
  // A dedicated, tagged pool so terminating it cannot disturb suites running in parallel.
  const tag = `resilience_${process.pid}`;
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set('application_name', tag);
  const lost: Error[] = [];
  const db = createPool(url.toString(), (err) => lost.push(err));
  afterAll(() => db.end());

  it('keeps serving after the server terminates its connections', async () => {
    const app = await buildApp({ db, config: h.config });
    const org = await createOrg(h);
    const harness = { ...h, app, db };

    // Open several pooled connections so they sit idle when killed.
    await Promise.all(Array.from({ length: 5 }, () => call(harness, 'GET', '/me', org.owner)));
    await h.db.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [tag]);
    await new Promise((r) => setTimeout(r, 200));

    expect(lost.length).toBeGreaterThan(0);
    expect((await call(harness, 'GET', '/health')).status).toBe(200);
    expect((await call(harness, 'GET', '/me', org.owner)).status).toBe(200);
    await app.close();
  });
});
