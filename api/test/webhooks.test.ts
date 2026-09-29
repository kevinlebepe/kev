import { describe, expect, it } from 'vitest';
import { checkWebhookUrl, deliverWebhooks, signWebhook } from '../src/webhooks.js';
import { call, createOrg, type TestOrg, useHarness } from './helpers.js';
import { started } from './fixtures.js';

const h = useHarness();

function receiver(status = 200) {
  const got: { url: string; headers: Record<string, string>; body: string }[] = [];
  return {
    got,
    send: async (url: string, init: { headers: Record<string, string>; body: string }) => {
      got.push({ url, ...init });
      return { status };
    },
  };
}

async function hook(org: TestOrg, events = ['attempt.submitted', 'result.released']) {
  const url = `https://hooks.example.com/${org.slug}`;
  const res = await call(h, 'PUT', '/integrations/webhook', org.owner, { url, events });
  expect(res.status).toBe(200);
  return { url, secret: res.body.secret as string };
}

const drain = (send: ReturnType<typeof receiver>['send']) => deliverWebhooks(h.db, { allowPrivate: true, send, limit: 500 });

describe('webhooks', () => {
  it('shows the secret once and only a hint after', async () => {
    const org = await createOrg(h);
    const { secret } = await hook(org);
    expect(secret).toMatch(/^whsec_/);
    const view = await call(h, 'GET', '/integrations/webhook', org.owner);
    expect(view.body).toMatchObject({ configured: true, enabled: true, events: ['attempt.submitted', 'result.released'] });
    expect(JSON.stringify(view.body)).not.toContain(secret);
    const again = await call(h, 'PUT', '/integrations/webhook', org.owner, { url: `https://hooks.example.com/x`, events: ['result.released'] });
    expect(again.body.secret).toBeUndefined();
    const rotated = await call(h, 'PUT', '/integrations/webhook', org.owner, { url: `https://hooks.example.com/x`, events: ['result.released'], rotateSecret: true });
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(secret);
  });

  it('sends a signed message when an attempt is submitted and when its result is released', async () => {
    const org = await createOrg(h);
    const { url, secret } = await hook(org);
    const c = await started(h, org);
    await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, {});
    const r = receiver();
    await drain(r.send);
    const submitted = r.got.filter((g) => g.url === url);
    expect(submitted).toHaveLength(1);
    const msg = submitted[0]!;
    expect(msg.headers['x-examguard-event']).toBe('attempt.submitted');
    expect(msg.headers['x-examguard-signature']).toBe(signWebhook(secret, Number(msg.headers['x-examguard-timestamp']), msg.body));
    const body = JSON.parse(msg.body);
    expect(body).toMatchObject({ event: 'attempt.submitted', data: { attemptId: c.attemptId, submittedBy: 'candidate', candidate: { id: c.candidateId } } });
    expect(msg.body).not.toContain('answers');

    // The exam has free text questions: mark them so the result can be released.
    const marking = await call(h, 'GET', `/marking/attempts/${c.attemptId}`, org.owner);
    const manual = marking.body.questions.filter((q: { auto: boolean; awarded: number | null }) => !q.auto && q.awarded === null);
    if (manual.length) await call(h, 'PUT', `/marking/attempts/${c.attemptId}`, org.owner, { marks: manual.map((q: { id: string }) => ({ questionId: q.id, points: 0 })) });
    await call(h, 'POST', `/sessions/${c.sessionId}/results/release`, org.owner);
    const r2 = receiver();
    await drain(r2.send);
    const released = r2.got.filter((g) => g.url === url);
    expect(released.map((g) => g.headers['x-examguard-event'])).toEqual(['result.released']);
    expect(JSON.parse(released[0]!.body).data).toMatchObject({ attemptId: c.attemptId, score: 0, maxScore: 11, percent: 0 });
  });

  it('only sends the events chosen, and nothing when switched off', async () => {
    const org = await createOrg(h);
    const { url } = await hook(org, ['result.released']);
    const c = await started(h, org);
    await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, {});
    const r = receiver();
    await drain(r.send);
    expect(r.got.filter((g) => g.url === url)).toEqual([]);

    await call(h, 'PUT', '/integrations/webhook', org.owner, { url, events: ['attempt.submitted'], enabled: false });
    const c2 = await started(h, org);
    await call(h, 'POST', `/attempts/${c2.attemptId}/submit`, c2.token, {});
    await drain(r.send);
    expect(r.got.filter((g) => g.url === url)).toEqual([]);
  });

  it('retries a failing receiver and gives up after too many tries', async () => {
    const org = await createOrg(h);
    await hook(org);
    expect((await call(h, 'POST', '/integrations/webhook/test', org.owner)).status).toBe(202);
    const failing = receiver(500);
    await drain(failing.send);
    let { rows } = await h.db.query(`SELECT attempts, failed_at, last_status FROM webhook_deliveries WHERE organisation_id = $1`, [org.id]);
    expect(rows[0]).toMatchObject({ attempts: 1, failed_at: null, last_status: 500 });
    await h.db.query(`UPDATE webhook_deliveries SET attempts = 7, next_attempt_at = now() WHERE organisation_id = $1`, [org.id]);
    await drain(failing.send);
    ({ rows } = await h.db.query(`SELECT attempts, failed_at FROM webhook_deliveries WHERE organisation_id = $1`, [org.id]));
    expect(rows[0].attempts).toBe(8);
    expect(rows[0].failed_at).not.toBeNull();
    const view = await call(h, 'GET', '/integrations/webhook', org.owner);
    expect(view.body.deliveries[0]).toMatchObject({ event: 'webhook.test', lastStatus: 500 });
  });

  it('never calls private network addresses', async () => {
    const resolve = async (host: string) => (host === 'internal.example.com' ? ['10.0.0.5'] : ['93.184.216.34']);
    await expect(checkWebhookUrl('https://internal.example.com/x', { allowPrivate: false, resolve })).rejects.toThrow(/public internet/);
    await expect(checkWebhookUrl('https://127.0.0.1/x', { allowPrivate: false, resolve })).rejects.toThrow(/public internet/);
    await expect(checkWebhookUrl('https://[::1]/x', { allowPrivate: false, resolve })).rejects.toThrow(/public internet/);
    await expect(checkWebhookUrl('https://[::ffff:192.168.1.1]/x', { allowPrivate: false, resolve })).rejects.toThrow(/public internet/);
    await expect(checkWebhookUrl('http://public.example.com/x', { allowPrivate: false, resolve })).rejects.toThrow(/HTTPS/);
    await expect(checkWebhookUrl('https://u:p@public.example.com/x', { allowPrivate: false, resolve })).rejects.toThrow(/user name/);
    await expect(checkWebhookUrl('https://public.example.com/x', { allowPrivate: false, resolve })).resolves.toBeUndefined();

    const org = await createOrg(h);
    await h.db.query(
      `INSERT INTO integration_configs (organisation_id, kind, config, enabled) VALUES ($1, 'webhook', $2, true)`,
      [org.id, { url: 'https://internal.example.com/x', events: ['attempt.submitted'], secret: 'whsec_x' }],
    );
    await call(h, 'POST', '/integrations/webhook/test', org.owner);
    const r = receiver();
    await deliverWebhooks(h.db, { allowPrivate: false, resolve, send: r.send, limit: 500 });
    expect(r.got.filter((g) => g.url.includes('internal'))).toEqual([]);
    const { rows } = await h.db.query(`SELECT failed_at, last_error FROM webhook_deliveries WHERE organisation_id = $1`, [org.id]);
    expect(rows[0].failed_at).not.toBeNull();
    expect(rows[0].last_error).toMatch(/public internet/);
  });

  it('is for organisation administrators only', async () => {
    const org = await createOrg(h);
    const c = await started(h, org);
    expect((await call(h, 'GET', '/integrations/webhook', c.token)).status).toBe(403);
  });
});
