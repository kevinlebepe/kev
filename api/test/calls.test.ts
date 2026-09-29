import { describe, expect, it } from 'vitest';
import { call, createOrg, invigilator, login, PASSWORD, type TestOrg, useHarness } from './helpers.js';
import { started } from './fixtures.js';

const h = useHarness();

async function watched(org: TestOrg) {
  const c = await started(h, org, { camera: true, microphone: true });
  const inv = await invigilator(h, org);
  await call(h, 'POST', `/sessions/${c.sessionId}/invigilators`, org.owner, { invigilatorIds: [inv.id] });
  await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId: c.sessionId });
  return { ...c, invToken: (await login(h, org.slug, inv.email)).accessToken };
}

const offer = { type: 'offer', sdp: 'v=0 fake offer' };
const answer = { type: 'answer', sdp: 'v=0 fake answer' };

describe('live calls', () => {
  it('passes the offer, answer and network candidates between the two sides, in order', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    const started = await call(h, 'POST', `/live/attempts/${c.attemptId}/calls`, c.invToken, { voice: true });
    expect(started.status).toBe(201);
    const callId = started.body.id;

    const beat = await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {});
    expect(beat.body.call).toEqual({ id: callId, voice: true });

    await call(h, 'POST', `/live/calls/${callId}/signals`, c.invToken, { type: 'offer', payload: offer });
    await call(h, 'POST', `/live/calls/${callId}/signals`, c.invToken, { type: 'ice', payload: { candidate: 'a' } });
    const toCandidate = await call(h, 'GET', `/attempts/${c.attemptId}/calls/${callId}/signals`, c.token);
    expect(toCandidate.body.status).toBe('open');
    expect(toCandidate.body.signals.map((s: { type: string }) => s.type)).toEqual(['offer', 'ice']);
    expect(toCandidate.body.signals[0].payload).toEqual(offer);

    await call(h, 'POST', `/attempts/${c.attemptId}/calls/${callId}/signals`, c.token, { type: 'answer', payload: answer });
    const toStaff = await call(h, 'GET', `/live/calls/${callId}/signals`, c.invToken);
    expect(toStaff.body.signals).toEqual([{ id: expect.any(Number), type: 'answer', payload: answer }]);
    const later = await call(h, 'GET', `/live/calls/${callId}/signals?after=${toStaff.body.signals[0].id}`, c.invToken);
    expect(later.body.signals).toEqual([]);

    await call(h, 'POST', `/live/calls/${callId}/end`, c.invToken);
    expect((await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {})).body.call).toBeNull();
    expect((await call(h, 'GET', `/attempts/${c.attemptId}/calls/${callId}/signals`, c.token)).body.status).toBe('ended');
    expect((await call(h, 'POST', `/attempts/${c.attemptId}/calls/${callId}/signals`, c.token, { type: 'ice', payload: {} })).status).toBe(409);

    const timeline = await call(h, 'GET', `/attempts/${c.attemptId}/timeline`, org.owner);
    expect(timeline.body.items.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['live_call_started', 'live_call_ended']));
    const { rows } = await h.db.query(`SELECT channel FROM invigilation_contacts WHERE organisation_id = $1`, [org.id]);
    expect(rows).toEqual([{ channel: 'voice' }]);
  });

  it('keeps calls to the invigilator’s own candidates and the candidate’s own attempt', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    const other = await invigilator(h, org);
    const otherToken = (await login(h, org.slug, other.email)).accessToken;
    expect((await call(h, 'POST', `/live/attempts/${c.attemptId}/calls`, otherToken, {})).status).toBe(404);

    const callId = (await call(h, 'POST', `/live/attempts/${c.attemptId}/calls`, c.invToken, {})).body.id;
    expect((await call(h, 'GET', `/live/calls/${callId}/signals`, otherToken)).status).toBe(404);
    const stranger = await started(h, org);
    expect((await call(h, 'GET', `/attempts/${c.attemptId}/calls/${callId}/signals`, stranger.token)).status).toBe(404);
    expect((await call(h, 'GET', `/attempts/${stranger.attemptId}/calls/${callId}/signals`, stranger.token)).status).toBe(404);
  });

  it('needs the voice permission to speak, and only one call runs at a time', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    const email = `mgr-${Date.now()}@${org.slug}.example`;
    await call(h, 'POST', `/organisations/${org.id}/users`, org.owner, { email, displayName: 'Manager', role: 'exam_manager', password: PASSWORD });
    const manager = (await login(h, org.slug, email)).accessToken;
    // An exam manager has neither live:view nor live:voice.
    expect((await call(h, 'POST', `/live/attempts/${c.attemptId}/calls`, manager, { voice: true })).status).toBe(403);

    const first = (await call(h, 'POST', `/live/attempts/${c.attemptId}/calls`, c.invToken, {})).body.id;
    const second = (await call(h, 'POST', `/live/attempts/${c.attemptId}/calls`, c.invToken, {})).body.id;
    expect((await call(h, 'GET', `/live/calls/${first}/signals`, c.invToken)).body.status).toBe('ended');
    expect((await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {})).body.call.id).toBe(second);
  });

  it('shares the ICE servers with signed in users only', async () => {
    const org = await createOrg(h);
    expect((await call(h, 'GET', '/live/ice-servers', org.owner)).body.iceServers[0].urls).toMatch(/^stun:/);
    expect((await call(h, 'GET', '/live/ice-servers')).status).toBe(401);
  });

  it('refuses oversized signals', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    const callId = (await call(h, 'POST', `/live/attempts/${c.attemptId}/calls`, c.invToken, {})).body.id;
    const res = await call(h, 'POST', `/live/calls/${callId}/signals`, c.invToken, { type: 'offer', payload: { sdp: 'x'.repeat(30_000) } });
    expect(res.status).toBe(400);
  });
});
