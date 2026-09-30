import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { call, createOrg, useHarness } from './helpers.js';
import { started } from './fixtures.js';

const h = useHarness();

/** A submitted attempt with a rule break, a flag, and two minutes offline. */
async function eventful() {
  const org = await createOrg(h);
  const c = await started(h, org);
  await call(h, 'POST', `/attempts/${c.attemptId}/events`, c.token, {
    events: [{ id: randomUUID(), type: 'left_fullscreen', occurredAt: new Date().toISOString() }],
  });
  expect((await call(h, 'POST', `/live/attempts/${c.attemptId}/flag`, org.owner, { reason: 'another_person', note: 'A voice in the room' })).status).toBe(201);
  expect((await call(h, 'POST', `/live/attempts/${c.attemptId}/flag`, org.owner, { reason: 'made_up' })).status).toBe(400);
  await h.db.query(`UPDATE attempts SET last_seen_at = now() - interval '2 minutes' WHERE id = $1`, [c.attemptId]);
  await call(h, 'POST', `/attempts/${c.attemptId}/heartbeat`, c.token, {});
  const mcq = c.questions[0]!;
  await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, { answers: [{ questionId: mcq.id, seq: 1, response: { optionId: mcq.options['4'] } }] });
  return { org, ...c };
}

describe('reports', () => {
  it('lists incidents with who raised them, as JSON and CSV', async () => {
    const e = await eventful();
    const res = await call(h, 'GET', `/reports/incidents?sessionId=${e.sessionId}`, e.org.owner);
    expect(res.status).toBe(200);
    const types = res.body.items.map((i: { type: string }) => i.type);
    expect(types).toEqual(expect.arrayContaining(['left_fullscreen', 'invigilator_flag', 'reconnected']));
    const flag = res.body.items.find((i: { type: string }) => i.type === 'invigilator_flag');
    expect(flag).toMatchObject({ severity: 'high', data: { reason: 'another_person', note: 'A voice in the room' } });
    expect(res.body.byType.length).toBeGreaterThan(0);

    const csv = await h.app.inject({ method: 'GET', url: `/reports/incidents?sessionId=${e.sessionId}&format=csv`, headers: { authorization: `Bearer ${e.org.owner}` } });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toBe('Time,Session,Candidate,Student ID,Event,Severity,Raised by,Details');
    expect(csv.body).toContain('invigilator_flag');
  });

  it('adds up time offline per candidate', async () => {
    const e = await eventful();
    const res = await call(h, 'GET', `/reports/blackouts?sessionId=${e.sessionId}`, e.org.owner);
    expect(res.body.summary).toMatchObject({ candidatesAffected: 1, interruptions: 1 });
    expect(res.body.items[0].totalSeconds).toBeGreaterThanOrEqual(119);
    expect(res.body.items[0]).toMatchObject({ overLimit: 0, attemptStatus: 'submitted' });
  });

  it('reports each invigilator and the session as it stands', async () => {
    const e = await eventful();
    const inv = await call(h, 'GET', `/reports/invigilation?sessionId=${e.sessionId}`, e.org.owner);
    expect(inv.status).toBe(200);
    expect(inv.body).toMatchObject({ unassigned: 0, items: [] });
    const health = await call(h, 'GET', `/reports/session-health?sessionId=${e.sessionId}`, e.org.owner);
    expect(health.body).toMatchObject({ assigned: 1, sitting: 0, submitted: 1, recentIncidents: 2 });
    const rec = await call(h, 'GET', `/reports/recording-health?sessionId=${e.sessionId}`, e.org.owner);
    expect(rec.body).toMatchObject({ expected: [], summary: { attempts: 1, complete: 1 } });
  });

  it('gives the whole attempt in one report, and records that it was read', async () => {
    const e = await eventful();
    const res = await call(h, 'GET', `/attempts/${e.attemptId}/report`, e.org.owner);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'submitted', submittedBy: 'candidate', score: 2, maxScore: 11, offline: { interruptions: 1 } });
    expect(res.body.answers[0]).toMatchObject({ answer: { choices: ['4'] }, awarded: 2 });
    expect(res.body.timeline.map((t: { type: string }) => t.type)).toContain('invigilator_flag');
    const { rows } = await h.db.query(`SELECT 1 FROM audit_logs WHERE action = 'report.attempt' AND target_id = $1`, [e.attemptId]);
    expect(rows).toHaveLength(1);
  });

  it('summarises the organisation', async () => {
    const e = await eventful();
    const res = await call(h, 'GET', '/reports/organisation', e.org.owner);
    expect(res.body.attempts).toMatchObject({ started: 1, submitted: 1, completionPercent: 100 });
    expect(res.body.results).toMatchObject({ pending: 0, marked: 1, released: 0 });
    expect(res.body.technicalEvents.find((t: { type: string }) => t.type === 'left_fullscreen')).toMatchObject({ count: 1, counted: true });
  });

  it('never lets a candidate name a member of staff in their own event data', async () => {
    const org = await createOrg(h);
    const c = await started(h, org);
    const ownerId = (await call(h, 'GET', '/me', org.owner)).body.user.id;
    await call(h, 'POST', `/attempts/${c.attemptId}/events`, c.token, {
      events: [
        { id: randomUUID(), type: 'left_window', occurredAt: new Date().toISOString(), data: { byUserId: ownerId } },
        { id: randomUUID(), type: 'copy_attempt', occurredAt: new Date().toISOString(), data: { byUserId: 'not-a-uuid' } },
      ],
    });
    const res = await call(h, 'GET', `/reports/incidents?sessionId=${c.sessionId}`, org.owner);
    expect(res.status).toBe(200);
    expect(res.body.items.every((i: { raisedBy: string | null }) => i.raisedBy === null)).toBe(true);
    expect((await call(h, 'GET', `/attempts/${c.attemptId}/report`, org.owner)).status).toBe(200);
  });

  it('keeps other organisations and people without the permission out', async () => {
    const e = await eventful();
    const other = await createOrg(h);
    expect((await call(h, 'GET', `/reports/blackouts?sessionId=${e.sessionId}`, other.owner)).status).toBe(404);
    expect((await call(h, 'GET', `/attempts/${e.attemptId}/report`, other.owner)).status).toBe(404);
    expect((await call(h, 'GET', '/reports/incidents', e.token)).status).toBe(403);
  });
});
