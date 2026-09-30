import { describe, expect, it } from 'vitest';
import { approvedCandidate, call, createOrg, minutesFromNow, publishedExam, session, uniq, useHarness } from './helpers.js';

const h = useHarness();

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffbf1e000501020154a24f5d0000000049454e44ae426082', 'hex');

describe('candidate groups', () => {
  it('assigns everyone in a group to a session at once', async () => {
    const org = await createOrg(h);
    const a = await approvedCandidate(h, org);
    const b = await approvedCandidate(h, org);
    const c = await approvedCandidate(h, org);
    const group = await call(h, 'POST', '/groups', org.owner, { name: 'BSc Year 1' });
    expect(group.status).toBe(201);
    expect((await call(h, 'POST', '/groups', org.owner, { name: 'bsc year 1' })).status).toBe(409);
    // A candidate of another organisation is quietly left out.
    const other = await createOrg(h);
    const stranger = await approvedCandidate(h, other);
    expect((await call(h, 'POST', `/groups/${group.body.id}/members/add`, org.owner, { candidateIds: [a, b, stranger] })).body).toEqual({ added: 2 });
    expect((await call(h, 'GET', '/groups', org.owner)).body.items).toMatchObject([{ name: 'BSc Year 1', members: 2 }]);

    const { versionId } = await publishedExam(h, org);
    const sessionId = await session(h, org, versionId, { startsAt: minutesFromNow(60), endsAt: minutesFromNow(180) });
    const assigned = await call(h, 'POST', '/assignments', org.owner, { sessionId, groupIds: [group.body.id], candidateIds: [c] });
    expect(assigned.body.assigned.sort()).toEqual([a, b, c].sort());
    expect((await call(h, 'POST', '/assignments', org.owner, { sessionId, groupIds: [(await call(h, 'POST', '/groups', other.owner, { name: 'Theirs' })).body.id] })).status).toBe(404);

    await call(h, 'POST', `/groups/${group.body.id}/members/remove`, org.owner, { candidateIds: [a] });
    expect((await call(h, 'GET', `/groups/${group.body.id}/members`, org.owner)).body.items.map((m: { id: string }) => m.id)).toEqual([b]);
  });
});

describe('exam access codes', () => {
  async function setup(startsInMinutes: number) {
    const org = await createOrg(h);
    const name = uniq('cand');
    const candidateId = await approvedCandidate(h, org, name);
    const { versionId } = await publishedExam(h, org);
    const sessionId = await session(h, org, versionId, { startsAt: minutesFromNow(startsInMinutes), endsAt: minutesFromNow(startsInMinutes + 120) });
    await call(h, 'POST', '/assignments', org.owner, { sessionId, candidateIds: [candidateId] });
    const { rows } = await h.db.query<{ id: string }>('SELECT id FROM exam_assignments WHERE session_id = $1', [sessionId]);
    return { org, candidateId, assignmentId: rows[0]!.id, email: `${name}@${org.slug}.example` };
  }

  it('signs a verified candidate in for their exam only around the exam time, if the organisation allows it', async () => {
    const s = await setup(-5);
    expect((await call(h, 'POST', `/assignments/${s.assignmentId}/access-code`, s.org.owner)).status).toBe(409);
    await call(h, 'PATCH', `/organisations/${s.org.id}`, s.org.owner, { allowAccessCodes: true });
    const issued = await call(h, 'POST', `/assignments/${s.assignmentId}/access-code`, s.org.owner);
    expect(issued.status).toBe(200);
    expect(issued.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Case and dashes do not matter; the wrong organisation does.
    const typed = issued.body.code.toLowerCase().replaceAll('-', ' ');
    expect((await call(h, 'POST', '/auth/access-code', null, { organisation: (await createOrg(h)).slug, code: typed })).status).toBe(401);
    const signedIn = await call(h, 'POST', '/auth/access-code', null, { organisation: s.org.slug, code: typed });
    expect(signedIn.status).toBe(200);
    const mine = await call(h, 'GET', '/me/entitlements', signedIn.body.accessToken);
    expect(mine.body.items.map((i: { id: string }) => i.id)).toEqual([s.assignmentId]);
    // The session ends with the exam, however often it is refreshed.
    const { rows } = await h.db.query<{ capped: boolean }>(
      `SELECT expires_at <= (SELECT ends_at FROM sessions s JOIN exam_assignments a ON a.session_id = s.id WHERE a.id = $1) AS capped
         FROM refresh_tokens WHERE hard_expires_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [s.assignmentId],
    );
    expect(rows[0]!.capped).toBe(true);
    const refreshed = await call(h, 'POST', '/auth/refresh', null, { refreshToken: signedIn.body.refreshToken });
    expect(refreshed.status).toBe(200);
    const { rows: again } = await h.db.query<{ hard: Date | null }>(`SELECT hard_expires_at AS hard FROM refresh_tokens ORDER BY created_at DESC LIMIT 1`);
    expect(again[0]!.hard).not.toBeNull();

    await call(h, 'DELETE', `/assignments/${s.assignmentId}/access-code`, s.org.owner);
    expect((await call(h, 'POST', '/auth/access-code', null, { organisation: s.org.slug, code: issued.body.code })).status).toBe(401);
  });

  it('does not work days before the exam', async () => {
    const s = await setup(60 * 48);
    await call(h, 'PATCH', `/organisations/${s.org.id}`, s.org.owner, { allowAccessCodes: true });
    const { code } = (await call(h, 'POST', `/assignments/${s.assignmentId}/access-code`, s.org.owner)).body;
    expect((await call(h, 'POST', '/auth/access-code', null, { organisation: s.org.slug, code })).status).toBe(401);
  });
});

describe('branding', () => {
  it('shows the organisation name, colour and logo to candidates before they sign in', async () => {
    const org = await createOrg(h);
    await call(h, 'PATCH', `/organisations/${org.id}`, org.owner, { brandColour: '#0a6e4f' });
    expect((await call(h, 'PATCH', `/organisations/${org.id}`, org.owner, { brandColour: 'red' })).status).toBe(400);
    const svg = await h.app.inject({ method: 'PUT', url: `/organisations/${org.id}/logo`, headers: { authorization: `Bearer ${org.owner}`, 'content-type': 'image/png' }, payload: Buffer.from('<svg onload="x"/>') });
    expect(svg.statusCode).toBe(400);
    const up = await h.app.inject({ method: 'PUT', url: `/organisations/${org.id}/logo`, headers: { authorization: `Bearer ${org.owner}`, 'content-type': 'image/png' }, payload: PNG });
    expect(up.statusCode).toBe(200);

    const pub = await call(h, 'GET', `/public/organisations/${org.slug}/branding`, null);
    expect(pub.body).toMatchObject({ colour: '#0a6e4f', logo: true, accessCodes: false });
    const logo = await h.app.inject({ method: 'GET', url: `/public/organisations/${org.slug}/logo` });
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.rawPayload.equals(PNG)).toBe(true);
    expect((await call(h, 'GET', '/public/organisations/no-such-org-here/branding', null)).status).toBe(404);
  });
});

describe('invigilator import', () => {
  it('adds each good row and reports the bad ones', async () => {
    const org = await createOrg(h);
    const email = (n: string) => `${uniq(n)}@${org.slug}.example`;
    const first = email('inv');
    const res = await call(h, 'POST', '/invigilators/import', org.owner, {
      items: [
        { email: first, displayName: 'First Invigilator', staffId: 'S1' },
        { email: email('inv'), displayName: 'Second', maxActive: 5 },
        { email: first, displayName: 'First again' },
      ],
    });
    expect(res.body.created).toHaveLength(2);
    expect(res.body.failed).toEqual([{ email: first, reason: 'This user is already an invigilator' }]);
    expect((await call(h, 'GET', '/invigilators', org.owner)).body.items).toHaveLength(2);
  });
});
