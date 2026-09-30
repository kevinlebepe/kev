import { describe, expect, it } from 'vitest';
import { checkHealth, monitorHealth, trackJob } from '../src/health.js';
import { memoryStore, type ObjectStore } from '../src/storage.js';
import { call, createOrg, superAdminToken, useHarness } from './helpers.js';
import { buildExam, candidateReady } from './fixtures.js';

const h = useHarness();

const broken: ObjectStore = {
  async put() {
    throw new Error('bucket unreachable');
  },
  async get() {
    return null;
  },
  async delete() {},
};

const find = (list: { name: string }[], name: string) => list.find((c) => c.name === name) as { status: string; message: string } | undefined;

describe('health checks', () => {
  it('reports each part, and finds storage down when it cannot write', async () => {
    const good = await checkHealth(h.db, h.config, memoryStore());
    expect(find(good, 'database')?.status).toBe('ok');
    expect(find(good, 'storage')?.status).toBe('ok');
    // The test settings have no TURN relay.
    expect(find(good, 'media')?.status).toBe('degraded');
    const bad = await checkHealth(h.db, h.config, broken);
    expect(find(bad, 'storage')).toMatchObject({ status: 'down', message: expect.stringContaining('bucket unreachable') });
    const withTurn = await checkHealth(h.db, { ...h.config, iceServers: [{ urls: 'turn:turn.example.org:3478', username: 'u', credential: 'c' }] }, memoryStore());
    expect(find(withTurn, 'media')?.status).toBe('ok');
  });

  it('calls missing email a limit, not an outage, so the public page stays calm', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const email = find(await checkHealth(h.db, { ...h.config, smtpUrl: null }, memoryStore()), 'email')!;
      expect(email.status).toBe('degraded');
      expect(email.message).toContain('SMTP_URL');
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it('notices a background job that has stopped running or keeps failing', async () => {
    await trackJob(h.db, 'expiry', async () => undefined);
    await h.db.query(`UPDATE job_runs SET last_finished_at = now() - interval '1 hour', last_started_at = now() - interval '1 hour' WHERE name = 'expiry'`);
    await expect(trackJob(h.db, 'webhooks', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const workers = find(await checkHealth(h.db, h.config, memoryStore()), 'workers')!;
    expect(workers.status).toBe('degraded');
    expect(workers.message).toContain('expiry');
    expect(workers.message).toContain('webhooks');
    await trackJob(h.db, 'expiry', async () => undefined);
    await trackJob(h.db, 'webhooks', async () => undefined);
  });

  it('emails the platform operators when a part breaks, and when it recovers', async () => {
    await superAdminToken(h);
    const store = memoryStore();
    await monitorHealth(h.db, h.config, store);
    const count = async () => (await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'service_incident'`)).rows[0]!.n;
    const before = await count();
    await monitorHealth(h.db, h.config, broken);
    const { rows } = await h.db.query(`SELECT payload FROM notifications WHERE kind = 'service_incident' ORDER BY created_at DESC LIMIT 1`);
    expect(await count()).toBeGreaterThan(before);
    expect(rows[0].payload.message).toContain('Recording storage is down');
    await monitorHealth(h.db, h.config, store);
    const { rows: after } = await h.db.query(`SELECT payload FROM notifications WHERE kind = 'service_incident' ORDER BY created_at DESC LIMIT 1`);
    expect(after[0].payload.message).toContain('Recording storage has recovered');
  });
});

describe('status and incidents', () => {
  it('shows a public status page with no internal detail', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.components.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['api', 'database', 'storage']));
    expect(JSON.stringify(body)).not.toMatch(/detail|message|connections|instance/);
  });

  it('tells staff when many candidates drop at once, rather than one by one', async () => {
    const org = await createOrg(h);
    const exam = await buildExam(h, org);
    const ids: string[] = [];
    let sessionId = '';
    for (let i = 0; i < 3; i++) {
      const c = await candidateReady(h, org, { exam });
      sessionId = c.sessionId;
      await call(h, 'PATCH', `/sessions/${c.sessionId}`, org.owner, { status: 'open' });
      ids.push((await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId })).body.id);
    }
    let health = await call(h, 'GET', '/system/health', org.owner);
    expect(health.body).toMatchObject({ sitting: 3, offline: 0 });
    expect(health.body.incidents).toEqual([]);

    await h.db.query(`UPDATE attempts SET last_seen_at = now() - interval '5 minutes' WHERE id = ANY($1::uuid[])`, [ids]);
    health = await call(h, 'GET', '/system/health', org.owner);
    expect(health.body.offline).toBe(3);
    expect(health.body.incidents).toEqual(expect.arrayContaining([expect.objectContaining({ area: 'widespread', severity: 'high' })]));
    expect(sessionId).not.toBe('');
    expect((await call(h, 'GET', '/system/health', (await createOrg(h)).owner)).body.sitting).toBe(0);
  });
});
