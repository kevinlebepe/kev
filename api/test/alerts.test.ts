import { describe, expect, it } from 'vitest';
import { sendReminders } from '../src/alerts.js';
import { render } from '../src/mail.js';
import { approvedCandidate, call, createOrg, invigilator, minutesFromNow, passingReport, publishedExam, session, type TestOrg, useHarness } from './helpers.js';
import { buildExam, candidateReady, started } from './fixtures.js';

const h = useHarness();

const kinds = async (where: string, params: unknown[]) =>
  (await h.db.query<{ kind: string; channel: string }>(`SELECT kind, channel FROM notifications WHERE ${where} ORDER BY created_at`, params)).rows;

async function ownerId(org: TestOrg): Promise<string> {
  return (await call(h, 'GET', '/me', org.owner)).body.user.id;
}

describe('email templates', () => {
  it('has a message for every notification that is emailed', () => {
    const row = { id: 'x', to: 'a@b.example', organisation_name: 'Wits', session_name: 'Maths 101', starts_at: new Date(), payload: {} as Record<string, unknown> };
    for (const kind of [
      'candidate_approved',
      'candidate_rejected',
      'readiness_failure',
      'precheck_reminder',
      'exam_starting_soon',
      'invigilator_session_starting',
      'submission_received',
      'invigilator_capacity_alert',
      'evidence_incomplete',
      'service_incident',
    ]) {
      const m = render({ ...row, kind, payload: { failed: ['camera', 'displays'], receiptId: 'r-1', submittedAt: new Date().toISOString(), answered: 3, total: 5 } }, h.config);
      expect(m, kind).not.toBeNull();
      expect(`${m!.subject} ${m!.text}`, kind).not.toMatch(/undefined|null|NaN|\[object/);
    }
    const failed = render({ ...row, kind: 'readiness_failure', payload: { failed: ['camera', 'displays'] } }, h.config);
    expect(failed!.text).toContain('camera, extra screens');
  });
});

describe('alerts', () => {
  it('emails the candidate what failed on the device check, and tells session staff in the portal', async () => {
    const org = await createOrg(h);
    const c = await candidateReady(h, org, { precheck: false });
    const res = await call(h, 'POST', `/me/entitlements/${c.assignmentId}/precheck`, c.token, { ...passingReport(), displays: { count: 2 } });
    expect(res.body.passed).toBe(false);
    expect(await kinds(`payload->>'assignmentId' = $1`, [c.assignmentId])).toEqual(
      expect.arrayContaining([
        { kind: 'readiness_failure', channel: 'email' },
        { kind: 'readiness_failure', channel: 'in_app' },
      ]),
    );

    const inbox = await call(h, 'GET', '/me/notifications', org.owner);
    expect(inbox.body.unread).toBeGreaterThanOrEqual(1);
    const item = inbox.body.items.find((i: { kind: string }) => i.kind === 'readiness_failure');
    expect(item).toMatchObject({ title: 'A device check failed', sessionId: c.sessionId });
    expect(item.body).toContain('displays');
    expect((await call(h, 'POST', '/me/notifications/read', org.owner, { ids: [item.id] })).body).toEqual({ read: 1 });
    await call(h, 'POST', '/me/notifications/read', org.owner, {});
    expect((await call(h, 'GET', '/me/notifications?unread=true', org.owner)).body).toMatchObject({ unread: 0, items: [] });
    // Nobody else can read or clear them.
    const other = await createOrg(h);
    expect((await call(h, 'GET', '/me/notifications', other.owner)).body.items.find((i: { id: string }) => i.id === item.id)).toBeUndefined();
  });

  it('emails the candidate a copy of the receipt when the exam is submitted', async () => {
    const org = await createOrg(h);
    const c = await started(h, org);
    const { receipt } = (await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, { answers: [] })).body;
    const { rows } = await h.db.query(`SELECT payload FROM notifications WHERE kind = 'submission_received' AND payload->>'receiptId' = $1`, [receipt.receiptId]);
    expect(rows[0].payload).toMatchObject({ sessionId: c.sessionId, answered: 0, total: 5 });
  });

  it('tells the invigilator and session staff when a candidate is offline past the limit', async () => {
    const org = await createOrg(h);
    const c = await candidateReady(h, org, { exam: await buildExam(h, org, undefined, undefined, { offline: { allowed: true, maxOfflineMinutes: 1 } }) });
    const attemptId = (await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId })).body.id;
    await h.db.query(`UPDATE attempts SET last_seen_at = now() - interval '3 minutes' WHERE id = $1`, [attemptId]);
    await call(h, 'POST', `/attempts/${attemptId}/heartbeat`, c.token, {});
    const inbox = await call(h, 'GET', '/me/notifications', org.owner);
    expect(inbox.body.items[0]).toMatchObject({ kind: 'candidate_offline', attemptId, title: 'A candidate was offline too long' });
  });

  it('alerts every session manager, in the portal and by email, when invigilators are full', async () => {
    const org = await createOrg(h);
    const { versionId } = await publishedExam(h, org, 1);
    const sessionId = await session(h, org, versionId, { startsAt: minutesFromNow(60 * 24), endsAt: minutesFromNow(60 * 26) });
    await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [await approvedCandidate(h, org), await approvedCandidate(h, org)] });
    const inv = await invigilator(h, org);
    await call(h, 'POST', `/sessions/${sessionId}/invigilators`, org.owner, { invigilatorIds: [inv.id] });
    await call(h, 'POST', '/live/assignments', org.owner, { mode: 'auto', sessionId });
    expect(await kinds(`kind = 'invigilator_capacity_alert' AND recipient_user_id = $1`, [await ownerId(org)])).toEqual([
      { kind: 'invigilator_capacity_alert', channel: 'in_app' },
      { kind: 'invigilator_capacity_alert', channel: 'email' },
    ]);
  });
});

describe('reminders', () => {
  it('reminds candidates to run the device check three days out, once', async () => {
    const org = await createOrg(h);
    const { versionId } = await publishedExam(h, org);
    const sessionId = await session(h, org, versionId, { startsAt: minutesFromNow(60 * 48), endsAt: minutesFromNow(60 * 50) });
    const candidateId = await approvedCandidate(h, org);
    await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [candidateId] });
    await sendReminders(h.db);
    await sendReminders(h.db);
    expect(await kinds(`kind = 'precheck_reminder' AND payload->>'sessionId' = $1`, [sessionId])).toEqual([{ kind: 'precheck_reminder', channel: 'email' }]);
    expect(await kinds(`kind = 'exam_starting_soon' AND payload->>'sessionId' = $1`, [sessionId])).toEqual([]);
  });

  it('tells candidates and invigilators an hour before the start', async () => {
    const org = await createOrg(h);
    const { versionId } = await publishedExam(h, org);
    const sessionId = await session(h, org, versionId, { startsAt: minutesFromNow(30), endsAt: minutesFromNow(200) });
    await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [await approvedCandidate(h, org)] });
    const inv = await invigilator(h, org);
    await call(h, 'POST', `/sessions/${sessionId}/invigilators`, org.owner, { invigilatorIds: [inv.id] });
    await sendReminders(h.db);
    await sendReminders(h.db);
    const sent = await kinds(`payload->>'sessionId' = $1 AND channel = 'email' AND kind <> 'exam_assigned'`, [sessionId]);
    expect(sent.map((s) => s.kind).sort()).toEqual(['exam_starting_soon', 'invigilator_session_starting', 'precheck_reminder']);
  });

  it('alerts session staff once when recordings are still missing a day after submission', async () => {
    const org = await createOrg(h);
    const c = await started(h, org);
    await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, { answers: [] });
    await h.db.query(`UPDATE submissions SET status = 'evidence_pending', received_at = now() - interval '2 days' WHERE attempt_id = $1`, [c.attemptId]);
    await sendReminders(h.db);
    await sendReminders(h.db);
    const alerts = await kinds(`kind = 'evidence_incomplete' AND recipient_user_id = $1`, [await ownerId(org)]);
    expect(alerts).toEqual([
      { kind: 'evidence_incomplete', channel: 'in_app' },
      { kind: 'evidence_incomplete', channel: 'email' },
    ]);
  });
});
