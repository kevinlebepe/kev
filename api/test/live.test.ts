import { describe, expect, it } from 'vitest';
import { call, createOrg, invigilator, login, type TestOrg, useHarness } from './helpers.js';
import { started } from './fixtures.js';

const h = useHarness();

/** A running attempt with an invigilator assigned to its candidate. */
async function watched(org: TestOrg) {
  const c = await started(h, org);
  const inv = await invigilator(h, org);
  await call(h, 'POST', `/sessions/${c.sessionId}/invigilators`, org.owner, { invigilatorIds: [inv.id] });
  const alloc = await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId: c.sessionId });
  expect(alloc.body.assignments).toHaveLength(1);
  const invToken = (await login(h, org.slug, inv.email)).accessToken;
  return { ...c, inv, invToken };
}

describe('live console', () => {
  it('shows an invigilator their candidates with attempt, presence and violations', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    await call(h, 'POST', `/attempts/${c.attemptId}/events`, c.token, {
      events: [{ id: crypto.randomUUID(), type: 'left_window', occurredAt: new Date().toISOString() }],
    });
    await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {});

    const sessions = await call(h, 'GET', '/live/sessions', c.invToken);
    expect(sessions.body.scope).toBe('invigilator');
    expect(sessions.body.items.map((s: { id: string }) => s.id)).toContain(c.sessionId);

    const view = await call(h, 'GET', `/live/sessions/${c.sessionId}`, c.invToken);
    expect(view.status).toBe(200);
    expect(view.body.scope).toBe('invigilator');
    expect(view.body.candidates).toHaveLength(1);
    expect(view.body.candidates[0]).toMatchObject({ attemptId: c.attemptId, attemptStatus: 'active', online: true, violations: 1 });
    expect(view.body.candidates[0].lastEvent.type).toBe('left_window');
  });

  it('lets a session manager supervise every candidate, and refuses staff with neither role', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    const view = await call(h, 'GET', `/live/sessions/${c.sessionId}`, org.owner);
    expect(view.body.scope).toBe('supervisor');
    expect(view.body.candidates[0].invigilatorName).toBe(c.inv.email);

    const email = `support-${Date.now()}@${org.slug}.example`;
    await call(h, 'POST', `/organisations/${org.id}/users`, org.owner, { email, displayName: 'Support', role: 'support', password: 'correct-horse-battery-staple' });
    const support = (await login(h, org.slug, email)).accessToken;
    expect((await call(h, 'GET', `/live/sessions/${c.sessionId}`, support)).status).toBe(403);
  });

  it('keeps another invigilator’s candidates out of reach', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    const other = await invigilator(h, org);
    const otherToken = (await login(h, org.slug, other.email)).accessToken;
    expect((await call(h, 'GET', `/live/attempts/${c.attemptId}`, otherToken)).status).toBe(404);
    expect((await call(h, 'POST', `/live/attempts/${c.attemptId}/messages`, otherToken, { body: 'hi' })).status).toBe(404);
    expect((await call(h, 'POST', `/live/attempts/${c.attemptId}/end`, otherToken, { reason: 'x' })).status).toBe(404);

    const otherOrg = await createOrg(h);
    expect((await call(h, 'GET', `/live/attempts/${c.attemptId}`, otherOrg.owner)).status).toBe(404);
  });

  it('delivers messages and warnings to the candidate once, in order', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    await call(h, 'POST', `/live/attempts/${c.attemptId}/messages`, c.invToken, { body: 'Please face the camera.' });
    await call(h, 'POST', `/live/attempts/${c.attemptId}/messages`, c.invToken, { kind: 'warning', body: 'Second person seen.' });

    const first = await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {});
    expect(first.body.messages.map((m: { kind: string; body: string }) => [m.kind, m.body])).toEqual([
      ['message', 'Please face the camera.'],
      ['warning', 'Second person seen.'],
    ]);
    const last = first.body.messages.at(-1).seq;
    const again = await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, { afterSeq: last });
    expect(again.body.messages).toEqual([]);

    const detail = await call(h, 'GET', `/live/attempts/${c.attemptId}`, c.invToken);
    expect(detail.body.messages.every((m: { deliveredAt: string | null }) => m.deliveredAt)).toBe(true);
    expect(detail.body.timeline.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['invigilator_message', 'invigilator_warning']),
    );
  });

  it('gives extra time, which the candidate sees, up to a limit', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    const before = Date.parse(c.start.deadlineAt);
    const res = await call(h, 'POST', `/live/attempts/${c.attemptId}/extend`, c.invToken, { minutes: 10, reason: 'Power cut' });
    expect(res.status).toBe(200);
    expect(Date.parse(res.body.deadlineAt) - before).toBe(10 * 60_000);

    const beat = await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {});
    expect(beat.body.deadlineAt).toBe(res.body.deadlineAt);
    expect(beat.body.messages[0].body).toBe('You have been given 10 extra minutes.');

    const tooMuch = await call(h, 'POST', `/live/attempts/${c.attemptId}/extend`, c.invToken, { minutes: 111, reason: 'x' });
    expect(tooMuch.status).toBe(409);
  });

  it('ends an attempt with a reason, keeping the answers, and the candidate learns of it', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    const q = c.questions[0]!;
    await call(h, 'PATCH', `/attempts/${c.attemptId}/state`, c.token, { answers: [{ questionId: q.id, seq: 1, response: { optionId: q.options['4'] } }] });

    const end = await call(h, 'POST', `/live/attempts/${c.attemptId}/end`, c.invToken, { reason: 'Phone in use' });
    expect(end.status).toBe(200);
    expect(end.body.receipt).toMatchObject({ submittedBy: 'system', answered: 1 });

    const beat = await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {});
    expect(beat.body.status).toBe('submitted');
    expect(beat.body.endedBy).toBe('invigilator');
    expect(beat.body.receipt.receiptId).toBe(end.body.receipt.receiptId);

    expect((await call(h, 'POST', `/live/attempts/${c.attemptId}/end`, c.invToken, { reason: 'again' })).status).toBe(409);
    const timeline = await call(h, 'GET', `/attempts/${c.attemptId}/timeline`, org.owner);
    expect(timeline.body.items.find((e: { type: string }) => e.type === 'attempt_ended_by_invigilator').data.reason).toBe('Phone in use');
  });

  it('records notes on the timeline', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    expect((await call(h, 'POST', `/live/attempts/${c.attemptId}/notes`, c.invToken, { note: 'Looked away often' })).status).toBe(201);
    const detail = await call(h, 'GET', `/live/attempts/${c.attemptId}`, c.invToken);
    expect(detail.body.timeline.at(-1)).toMatchObject({ type: 'invigilator_note', data: { note: 'Looked away often' } });
  });
});

describe('sessions', () => {
  it('lists sessions and only allows sensible status changes', async () => {
    const org = await createOrg(h);
    const c = await started(h, org);
    const list = await call(h, 'GET', '/sessions', org.owner);
    expect(list.body.items[0]).toMatchObject({ id: c.sessionId, candidates: 1, submitted: 0, examName: 'Attempts exam' });

    expect((await call(h, 'PATCH', `/sessions/${c.sessionId}`, org.owner, { status: 'closed' })).status).toBe(409);
    expect((await call(h, 'PATCH', `/sessions/${c.sessionId}`, org.owner, { status: 'open' })).body.status).toBe('open');
    expect((await call(h, 'PATCH', `/sessions/${c.sessionId}`, org.owner, { startsAt: new Date().toISOString() })).status).toBe(409);
    expect((await call(h, 'PATCH', `/sessions/${c.sessionId}`, org.owner, { status: 'closed' })).body.status).toBe('closed');
    expect((await call(h, 'PATCH', `/sessions/${c.sessionId}`, org.owner, { status: 'open' })).status).toBe(409);
  });
});

describe('offline time', () => {
  it('records a long silence, and says when it went past the exam’s limit', async () => {
    const org = await createOrg(h);
    const c = await watched(org);
    await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {});
    // Short gaps are normal and not recorded.
    await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {});
    await h.db.query(`UPDATE attempts SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [c.attemptId]);
    await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {});
    // The exam allows 30 minutes offline by default.
    await h.db.query(`UPDATE attempts SET last_seen_at = now() - interval '45 minutes' WHERE id = $1`, [c.attemptId]);
    await call(h, 'PATCH', `/attempts/${c.attemptId}/state`, c.token, { answers: [] });

    const detail = await call(h, 'GET', `/live/attempts/${c.attemptId}`, c.invToken);
    const offline = detail.body.timeline.filter((e: { type: string }) => ['reconnected', 'offline_limit_exceeded'].includes(e.type));
    expect(offline.map((e: { type: string; severity: string }) => [e.type, e.severity])).toEqual([
      ['reconnected', 'warning'],
      ['offline_limit_exceeded', 'high'],
    ]);
    expect(offline[0].data.offlineSeconds).toBeGreaterThanOrEqual(300);
    expect(offline[1].data.allowedMinutes).toBe(30);
  });
});
