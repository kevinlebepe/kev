import { describe, expect, it } from 'vitest';
import { approvedCandidate, call, createOrg, invigilator, login, publishedExam, useHarness } from './helpers.js';

const h = useHarness();

// Spec section 22: "A candidate from Organisation A cannot access Organisation B data."
describe('tenant isolation and RBAC', () => {
  it('an admin of one organisation cannot see or act on another organisation’s data', async () => {
    const a = await createOrg(h);
    const b = await createOrg(h);
    const candidateA = await approvedCandidate(h, a);
    const { examId, versionId } = await publishedExam(h, a);

    expect((await call(h, 'GET', `/candidates/${candidateA}`, b.owner)).status).toBe(404);
    expect((await call(h, 'POST', `/candidates/${candidateA}/block`, b.owner, {})).status).toBe(404);
    expect((await call(h, 'GET', `/exams/${examId}`, b.owner)).status).toBe(404);
    expect((await call(h, 'GET', `/exam-versions/${versionId}/package`, b.owner)).status).toBe(404);
    expect((await call(h, 'GET', `/organisations/${a.id}`, b.owner)).status).toBe(404);
    expect((await call(h, 'POST', '/sessions', b.owner, {
      examVersionId: versionId,
      name: 'Hijack',
      startsAt: '2026-10-14T09:00:00Z',
      endsAt: '2026-10-14T10:00:00Z',
    })).status).toBe(404);

    const listB = await call(h, 'GET', '/candidates', b.owner);
    expect(listB.body.items.map((c: { id: string }) => c.id)).not.toContain(candidateA);
  });

  it('cannot attach another organisation’s questions to an exam', async () => {
    const a = await createOrg(h);
    const b = await createOrg(h);
    const { questionId } = await publishedExam(h, a);
    const examB = await call(h, 'POST', '/exams', b.owner, { code: 'B1', name: 'B exam' });
    const res = await call(h, 'PUT', `/exams/${examB.body.id}/questions`, b.owner, { items: [{ questionId }] });
    expect(res.status).toBe(400);
  });

  it('enforces permissions on the backend regardless of UI', async () => {
    const org = await createOrg(h);
    const inv = await invigilator(h, org);
    const { accessToken } = await login(h, org.slug, inv.email);

    expect((await call(h, 'POST', '/candidates/invite', accessToken, { email: 'x@y.example', fullName: 'X' })).status).toBe(403);
    expect((await call(h, 'POST', '/exams', accessToken, { code: 'X', name: 'X' })).status).toBe(403);
    expect((await call(h, 'GET', '/audit', accessToken)).status).toBe(403);

    // Admins cannot mint owners; only holders of organisation:manage_security can.
    const admin = await call(h, 'POST', `/organisations/${org.id}/users`, org.owner, {
      email: `admin-${org.slug}@x.example`,
      displayName: 'Admin',
      password: 'correct-horse-battery-staple',
      role: 'admin',
    });
    expect(admin.status).toBe(201);
    const adminToken = (await login(h, org.slug, `admin-${org.slug}@x.example`)).accessToken;
    const escalate = await call(h, 'POST', `/organisations/${org.id}/users`, adminToken, {
      email: `evil-${org.slug}@x.example`,
      displayName: 'Evil',
      password: 'correct-horse-battery-staple',
      role: 'owner',
    });
    expect(escalate.status).toBe(403);
  });

  it('non-super-admins cannot create organisations', async () => {
    const org = await createOrg(h);
    const res = await call(h, 'POST', '/platform/organisations', org.owner, {
      slug: 'nope-nope',
      name: 'Nope',
      mode: 'school',
      owner: { email: 'n@n.example', displayName: 'N', password: 'correct-horse-battery-staple' },
    });
    expect(res.status).toBe(403);
  });
});

// Spec section 22: "All privileged actions are auditable."
describe('audit trail', () => {
  it('records privileged actions and cannot be altered', async () => {
    const org = await createOrg(h);
    await approvedCandidate(h, org);
    const log = await call(h, 'GET', '/audit', org.owner);
    const actions = log.body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['candidate.invite', 'candidate.invitation_accepted', 'candidate.approve']));

    await expect(h.db.query(`UPDATE audit_logs SET action = 'x' WHERE organisation_id = $1`, [org.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(h.db.query(`DELETE FROM audit_logs WHERE organisation_id = $1`, [org.id])).rejects.toThrow(/append-only/);
  });
});
