import { describe, expect, it } from 'vitest';
import { call, createOrg, login, PASSWORD, useHarness } from './helpers.js';

const h = useHarness();

describe('authentication', () => {
  it('rejects wrong passwords and unknown organisations with the same message', async () => {
    const org = await createOrg(h);
    const wrongPassword = await call(h, 'POST', '/auth/login', null, {
      organisation: org.slug,
      email: org.ownerEmail,
      password: 'not-the-password',
    });
    const wrongOrg = await call(h, 'POST', '/auth/login', null, {
      organisation: 'no-such-org',
      email: org.ownerEmail,
      password: PASSWORD,
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongOrg.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(wrongOrg.body.error.message);
  });

  it('requires a token on protected endpoints', async () => {
    expect((await call(h, 'GET', '/candidates')).status).toBe(401);
    expect((await call(h, 'GET', '/candidates', 'garbage')).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the chain when an old one is replayed', async () => {
    const org = await createOrg(h);
    const first = await login(h, org.slug, org.ownerEmail);

    const second = await call(h, 'POST', '/auth/refresh', null, { refreshToken: first.refreshToken });
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);

    // Replaying the rotated token is treated as theft...
    const replay = await call(h, 'POST', '/auth/refresh', null, { refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    // ...which also kills the legitimately rotated token.
    const afterReplay = await call(h, 'POST', '/auth/refresh', null, { refreshToken: second.body.refreshToken });
    expect(afterReplay.status).toBe(401);
  });

  it('stops honouring a token as soon as membership is suspended', async () => {
    const org = await createOrg(h);
    expect((await call(h, 'GET', '/me', org.owner)).status).toBe(200);
    await h.db.query(`UPDATE organisation_users SET status = 'suspended' WHERE organisation_id = $1`, [org.id]);
    expect((await call(h, 'GET', '/me', org.owner)).status).toBe(401);
  });
});

describe('login rate limit', () => {
  it('cannot be bypassed by rotating X-Forwarded-For', async () => {
    const { buildApp } = await import('../src/app.js');
    const app = await buildApp({ db: h.db, config: { ...h.config, authRateLimitPerMinute: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
        payload: { email: 'nobody@example.com', password: 'wrong-password-123' },
      });
      statuses.push(res.statusCode);
    }
    await app.close();
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });
});
