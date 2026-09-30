import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { approvedCandidate, call, createOrg, invigilator, minutesFromNow, publishedExam, session, useHarness } from './helpers.js';

const h = useHarness();

describe('API version prefix and request ids', () => {
  it('answers the same under /v1', async () => {
    const org = await createOrg(h);
    const plain = await call(h, 'GET', '/me', org.owner);
    const versioned = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${org.owner}` } });
    expect(versioned.statusCode).toBe(200);
    expect(versioned.json().user.id).toBe(plain.body.user.id);
    expect((await h.app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(200);
  });

  it('keeps a well formed request id from the load balancer, and replaces anything else', async () => {
    const kept = await h.app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'lb-12345' } });
    expect(kept.headers['x-request-id']).toBe('lb-12345');
    const replaced = await h.app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'bad id <script>' } });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('metrics', () => {
  it('reports requests by route, queues and exam activity', async () => {
    await h.app.inject({ method: 'GET', url: '/health' });
    const res = await h.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toMatch(/examguard_http_requests_total\{method="GET",route="\/health",status="200"\} \d+/);
    expect(res.body).toMatch(/examguard_http_request_duration_seconds_bucket\{method="GET",route="\/health",le="\+Inf"\} \d+/);
    for (const name of ['examguard_db_connections', 'examguard_email_queue_depth', 'examguard_attempts_active', 'examguard_webrtc_sessions_open', 'examguard_database_up 1']) {
      expect(res.body).toContain(name);
    }
  });

  it('needs the token when one is set', async () => {
    const app = await buildApp({ db: h.db, config: { ...h.config, metricsToken: 'metrics-secret' }, store: h.store });
    try {
      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer wrong-secret!' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-secret' } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

const REDIS = ['/usr/bin/redis-server', '/usr/local/bin/redis-server'].find((p) => existsSync(p));
let redis: ChildProcess | null = null;
afterAll(() => redis?.kill());

describe.skipIf(!REDIS)('rate limits shared through Redis', () => {
  it('counts sign in attempts across instances', async () => {
    const port = 26379 + Math.floor(Math.random() * 1000);
    redis = spawn(REDIS!, ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    const probe = new Redis(`redis://127.0.0.1:${port}`, { retryStrategy: (n) => (n > 50 ? null : 100) });
    await probe.ping();
    await probe.quit();
    const config = { ...h.config, authRateLimitPerMinute: 3, redisUrl: `redis://127.0.0.1:${port}` };
    const one = await buildApp({ db: h.db, config, store: h.store });
    const two = await buildApp({ db: h.db, config, store: h.store });
    try {
      const attempt = (app: typeof one) =>
        app.inject({ method: 'POST', url: '/auth/login', payload: { organisation: 'nobody', email: 'nobody@example.org', password: 'wrong password here' }, remoteAddress: '203.0.113.9' });
      expect((await attempt(one)).statusCode).toBe(401);
      expect((await attempt(two)).statusCode).toBe(401);
      expect((await attempt(one)).statusCode).toBe(401);
      // The fourth, on either instance, is refused.
      expect((await attempt(two)).statusCode).toBe(429);
    } finally {
      await one.close();
      await two.close();
    }
  });
});

describe('exam event checklist', () => {
  it('works out what it can, and records who confirmed the rest', async () => {
    const org = await createOrg(h);
    const { versionId } = await publishedExam(h, org, 1);
    const sessionId = await session(h, org, versionId, { startsAt: minutesFromNow(60 * 24), endsAt: minutesFromNow(60 * 26) });
    let list = await call(h, 'GET', `/sessions/${sessionId}/checklist`, org.owner);
    const state = (key: string) => list.body.items.find((i: { key: string }) => i.key === key);
    expect(list.body.ready).toBe(false);
    expect(state('roster')).toMatchObject({ state: 'todo' });
    expect(state('exam_version')).toMatchObject({ state: 'ok' });

    await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [await approvedCandidate(h, org), await approvedCandidate(h, org)] });
    const inv = await invigilator(h, org);
    await call(h, 'POST', `/sessions/${sessionId}/invigilators`, org.owner, { invigilatorIds: [inv.id] });
    list = await call(h, 'GET', `/sessions/${sessionId}/checklist`, org.owner);
    expect(state('roster')).toMatchObject({ state: 'ok' });
    // One invigilator at one candidate each cannot watch two.
    expect(state('invigilators')).toMatchObject({ state: 'warn', detail: expect.stringContaining('2 needed') });
    expect(state('device_checks')).toMatchObject({ state: 'warn', detail: '0 of 2 candidates have passed the device check.' });

    expect((await call(h, 'PUT', `/sessions/${sessionId}/checklist/roster`, org.owner, { done: true })).status).toBe(400);
    await call(h, 'PUT', `/sessions/${sessionId}/checklist/backups_verified`, org.owner, { done: true });
    list = await call(h, 'GET', `/sessions/${sessionId}/checklist`, org.owner);
    expect(state('backups_verified')).toMatchObject({ state: 'ok', manual: true, doneBy: expect.any(String) });
    await call(h, 'PUT', `/sessions/${sessionId}/checklist/backups_verified`, org.owner, { done: false });
    list = await call(h, 'GET', `/sessions/${sessionId}/checklist`, org.owner);
    expect(state('backups_verified')).toMatchObject({ state: 'todo' });
    expect((await call(h, 'GET', `/sessions/${sessionId}/checklist`, (await createOrg(h)).owner)).status).toBe(404);
  });
});
