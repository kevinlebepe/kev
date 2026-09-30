import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyRetention } from '../src/retention.js';
import { call, createOrg, login, PASSWORD, superAdminToken, type TestOrg, uniq, useHarness } from './helpers.js';
import { buildExam, candidateReady, started } from './fixtures.js';

const h = useHarness();

async function staff(org: TestOrg, role: string) {
  const email = `${uniq(role)}@${org.slug}.example`;
  expect((await call(h, 'POST', `/organisations/${org.id}/users`, org.owner, { email, displayName: `${role} person`, role, password: PASSWORD })).status).toBe(201);
  return (await login(h, org.slug, email)).accessToken;
}

/** A submitted attempt with one camera piece and a still. */
async function recorded(org: TestOrg) {
  const c = await started(h, org, { camera: true });
  const body = Buffer.from('piece');
  const res = await h.app.inject({
    method: 'POST',
    url: `/attempts/${c.attemptId}/recording/camera/0`,
    headers: {
      authorization: `Bearer ${c.token}`,
      'content-type': 'video/webm',
      'x-chunk-sha256': createHash('sha256').update(body).digest('hex'),
      'x-chunk-start': new Date(Date.now() - 1000).toISOString(),
      'x-chunk-end': new Date().toISOString(),
    },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  const essay = c.questions[4]!;
  await call(h, 'POST', `/attempts/${c.attemptId}/submit`, c.token, { answers: [{ questionId: essay.id, seq: 1, response: { text: 'My private essay' } }] });
  const list = await call(h, 'GET', `/attempts/${c.attemptId}/recordings`, org.owner);
  return { ...c, chunkId: list.body.streams[0].chunks[0].id as string, key: `${org.id}/${c.attemptId}/camera/000000.webm` };
}

describe('candidate notice', () => {
  it('shows the organisation notice, and starts only once the candidate agrees to the current text', async () => {
    const org = await createOrg(h);
    const text = 'We record your camera for this exam and keep it for a year.';
    const patched = await call(h, 'PATCH', `/organisations/${org.id}`, org.owner, { candidateNotice: text });
    expect(patched.body.candidateNotice).toBe(text);
    const c = await candidateReady(h, org);
    const pkg = await call(h, 'GET', `/me/entitlements/${c.assignmentId}/package`, c.token);
    expect(pkg.body.notice).toEqual({ text, sha256: createHash('sha256').update(text).digest('hex') });

    expect((await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId })).status).toBe(409);
    expect((await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId, noticeSha256: '0'.repeat(64) })).status).toBe(409);
    const ok = await call(h, 'POST', '/attempts/start', c.token, { assignmentId: c.assignmentId, noticeSha256: pkg.body.notice.sha256 });
    expect(ok.status).toBe(201);
    const { rows } = await h.db.query(`SELECT data FROM events WHERE attempt_id = $1 AND type = 'attempt_started'`, [ok.body.id]);
    expect(rows[0].data.noticeAgreed).toBe(pkg.body.notice.sha256);

    // Removing the notice lets candidates start without it.
    await call(h, 'PATCH', `/organisations/${org.id}`, org.owner, { candidateNotice: null });
    const d = await candidateReady(h, org);
    expect((await call(h, 'GET', `/me/entitlements/${d.assignmentId}/package`, d.token)).body.notice).toBeNull();
    expect((await call(h, 'POST', '/attempts/start', d.token, { assignmentId: d.assignmentId })).status).toBe(201);
  });
});

describe('recording access', () => {
  it('records every view, and needs its own permission to download', async () => {
    const org = await createOrg(h);
    const r = await recorded(org);
    const view = await h.app.inject({ method: 'GET', url: `/recording-chunks/${r.chunkId}`, headers: { authorization: `Bearer ${org.owner}` } });
    expect(view.statusCode).toBe(200);
    expect(view.headers['content-disposition']).toBeUndefined();
    const reviewer = await staff(org, 'reviewer');
    expect((await h.app.inject({ method: 'GET', url: `/recording-chunks/${r.chunkId}`, headers: { authorization: `Bearer ${reviewer}` } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: `/recording-chunks/${r.chunkId}?download=1`, headers: { authorization: `Bearer ${reviewer}` } })).statusCode).toBe(403);
    const dl = await h.app.inject({ method: 'GET', url: `/recording-chunks/${r.chunkId}?download=1`, headers: { authorization: `Bearer ${org.owner}` } });
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="${r.attemptId}-camera-0.webm"`);
    const { rows } = await h.db.query(`SELECT action FROM audit_logs WHERE target_id = $1 AND action LIKE 'recording.%' ORDER BY id`, [r.attemptId]);
    expect(rows.map((x) => x.action)).toEqual(['recording.list', 'recording.view', 'recording.view', 'recording.download']);
  });
});

describe('holds', () => {
  it('keeps a held attempt past the retention period, until the hold is lifted', async () => {
    const org = await createOrg(h);
    const r = await recorded(org);
    await call(h, 'PATCH', `/organisations/${org.id}`, org.owner, { recordingRetentionDays: 30 });
    expect((await call(h, 'POST', `/attempts/${r.attemptId}/hold`, org.owner, { reason: 'Appeal 2026/14' })).body).toEqual({ held: true, reason: 'Appeal 2026/14' });
    await h.db.query(`UPDATE attempts SET submitted_at = now() - interval '60 days' WHERE id = $1`, [r.attemptId]);
    await applyRetention(h.db, h.store, 5000);
    expect(h.store.keys()).toContain(r.key);
    await call(h, 'DELETE', `/attempts/${r.attemptId}/hold`, org.owner);
    await applyRetention(h.db, h.store, 5000);
    expect(h.store.keys()).not.toContain(r.key);
  });
});

describe('export and erasure', () => {
  it('exports everything held about a candidate, and the candidate can get their own copy', async () => {
    const org = await createOrg(h);
    const r = await recorded(org);
    const res = await h.app.inject({ method: 'GET', url: `/candidates/${r.candidateId}/export`, headers: { authorization: `Bearer ${org.owner}` } });
    expect(res.headers['content-disposition']).toContain('attachment');
    const data = res.json();
    expect(data.candidate.id).toBe(r.candidateId);
    expect(data.attempts[0].answers[0].response).toEqual({ text: 'My private essay' });
    expect(data.attempts[0].recordings[0]).toMatchObject({ stream: 'camera', pieces: 1 });
    expect(data.deviceChecks.length).toBeGreaterThan(0);
    const own = (await call(h, 'GET', '/me/export', r.token)).body;
    expect(own.candidate.id).toBe(r.candidateId);
    // Not yet released, so the candidate's copy leaves the result out.
    expect(own.attempts[0].result).toBeNull();
  });

  it('erases a candidate: identity, answers, recordings and account, keeping the score and the audit trail', async () => {
    const org = await createOrg(h);
    const r = await recorded(org);
    const { rows: before } = await h.db.query<{ email: string; user_id: string }>('SELECT email, user_id FROM candidates WHERE id = $1', [r.candidateId]);
    const admin = await staff(org, 'admin');
    expect((await call(h, 'POST', `/candidates/${r.candidateId}/erase`, admin, { confirmEmail: before[0]!.email })).status).toBe(403);
    expect((await call(h, 'POST', `/candidates/${r.candidateId}/erase`, org.owner, { confirmEmail: 'wrong@example.org' })).status).toBe(400);

    await call(h, 'POST', `/attempts/${r.attemptId}/hold`, org.owner, { reason: 'Investigation' });
    expect((await call(h, 'POST', `/candidates/${r.candidateId}/erase`, org.owner, { confirmEmail: before[0]!.email })).status).toBe(409);
    await call(h, 'DELETE', `/attempts/${r.attemptId}/hold`, org.owner);

    const out = await call(h, 'POST', `/candidates/${r.candidateId}/erase`, org.owner, { confirmEmail: before[0]!.email.toUpperCase() });
    expect(out.body).toEqual({ erased: true, recordingPieces: 1, files: 0, accountErased: true });
    expect(h.store.keys()).not.toContain(r.key);
    const { rows: cand } = await h.db.query('SELECT email, full_name, erased_at, status FROM candidates WHERE id = $1', [r.candidateId]);
    expect(cand[0]).toMatchObject({ full_name: 'Erased candidate', status: 'blocked' });
    expect(cand[0].email).toMatch(/@erased\.invalid$/);
    const { rows: ans } = await h.db.query('SELECT response FROM answers WHERE attempt_id = $1', [r.attemptId]);
    expect(ans.every((a) => JSON.stringify(a.response) === '{}')).toBe(true);
    const { rows: res } = await h.db.query('SELECT score FROM results WHERE attempt_id = $1', [r.attemptId]);
    expect(res).toHaveLength(1);
    const { rows: user } = await h.db.query('SELECT email, password_hash FROM users WHERE id = $1', [before[0]!.user_id]);
    expect(user[0]).toMatchObject({ password_hash: null });
    expect((await call(h, 'POST', '/auth/login', null, { organisation: org.slug, email: before[0]!.email, password: PASSWORD })).status).toBe(401);
    expect((await call(h, 'POST', `/candidates/${r.candidateId}/erase`, org.owner, { confirmEmail: 'x@erased.invalid' })).status).toBe(409);
    const { rows: log } = await h.db.query(`SELECT data FROM audit_logs WHERE target_id = $1 AND action = 'candidate.erase'`, [r.candidateId]);
    expect(JSON.stringify(log[0].data)).not.toContain(before[0]!.email);
  });
});

describe('support cases', () => {
  it('lets a candidate ask for help, routes it, and lets support reply', async () => {
    const org = await createOrg(h);
    const c = await candidateReady(h, org);
    const opened = await call(h, 'POST', '/me/support', c.token, { category: 'accommodation', summary: 'I need extra time', details: 'Letter attached by email.', entitlementId: c.assignmentId });
    expect(opened.body).toMatchObject({ scope: 'organisation', status: 'open' });
    const tech = await call(h, 'POST', '/me/support', c.token, { category: 'device_check', summary: 'Camera not found' });
    expect(tech.body.scope).toBe('platform');

    // A support agent handles cases but no longer browses candidates.
    const agent = await staff(org, 'support');
    expect((await call(h, 'GET', '/candidates', agent)).status).toBe(403);
    const list = await call(h, 'GET', '/support-cases?status=open', agent);
    expect(list.body.items).toHaveLength(2);
    const detail = await call(h, 'GET', `/support-cases/${opened.body.id}`, agent);
    expect(detail.body).toMatchObject({ candidateName: expect.any(String), sessionName: 'Morning sitting', lastDeviceCheck: { passed: true } });
    const replied = await call(h, 'PATCH', `/support-cases/${opened.body.id}`, agent, { reply: 'Approved: 30 extra minutes.', status: 'resolved' });
    expect(replied.body).toMatchObject({ status: 'resolved', reply: 'Approved: 30 extra minutes.', repliedBy: 'support person' });
    const mine = await call(h, 'GET', '/me/support', c.token);
    expect(mine.body.items.find((i: { id: string }) => i.id === opened.body.id)).toMatchObject({ status: 'resolved', reply: 'Approved: 30 extra minutes.' });
    const { rows } = await h.db.query(`SELECT 1 FROM notifications WHERE kind = 'support_reply' AND payload->>'caseId' = $1`, [opened.body.id]);
    expect(rows).toHaveLength(1);

    // Platform support sees only the platform case, and another organisation sees neither.
    const root = await superAdminToken(h);
    const platform = await call(h, 'GET', '/platform/support-cases?status=open', root);
    const ids = platform.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(tech.body.id);
    expect(ids).not.toContain(opened.body.id);
    expect((await call(h, 'PATCH', `/platform/support-cases/${opened.body.id}`, root, { status: 'resolved' })).status).toBe(404);
    expect((await call(h, 'GET', `/support-cases/${opened.body.id}`, (await createOrg(h)).owner)).status).toBe(404);
  });

  it('keeps one candidate from flooding staff with requests', async () => {
    const org = await createOrg(h);
    const c = await candidateReady(h, org, { exam: await buildExam(h, org) });
    for (let i = 0; i < 10; i++) expect((await call(h, 'POST', '/me/support', c.token, { category: 'other', summary: `Question ${i}` })).status).toBe(201);
    expect((await call(h, 'POST', '/me/support', c.token, { category: 'other', summary: 'One more' })).status).toBe(409);
  });
});
