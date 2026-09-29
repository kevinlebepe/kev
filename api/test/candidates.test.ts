import { describe, expect, it } from 'vitest';
import { call, createOrg, latestLinkToken, login, PASSWORD, uniq, useHarness } from './helpers.js';

const h = useHarness();

describe('candidate onboarding and approval', () => {
  it('invitation → accept → pending approval → approved', async () => {
    const org = await createOrg(h);
    const email = `${uniq('sarah')}@${org.slug}.example`;

    const invited = await call(h, 'POST', '/candidates/invite', org.owner, {
      email,
      fullName: 'Sarah M.',
      studentId: '20261234',
      programme: 'BSc Computer Science',
    });
    expect(invited.status).toBe(201);
    expect(invited.body.status).toBe('invited');

    // An invited candidate cannot yet be approved.
    expect((await call(h, 'POST', `/candidates/${invited.body.id}/approve`, org.owner, {})).status).toBe(409);

    const token = await latestLinkToken(h, email);
    const accepted = await call(h, 'POST', '/public/invitations/accept', null, { token, password: PASSWORD });
    expect(accepted.body).toMatchObject({ candidateId: invited.body.id, status: 'pending_approval' });

    // Invitation tokens are single-use.
    expect((await call(h, 'POST', '/public/invitations/accept', null, { token, password: PASSWORD })).status).toBe(400);

    const approved = await call(h, 'POST', `/candidates/${invited.body.id}/approve`, org.owner, {});
    expect(approved.body).toMatchObject({ status: 'approved', identityStatus: 'verified' });

    // The candidate can now sign in, but holds no staff permissions.
    const session = await login(h, org.slug, email);
    const me = await call(h, 'GET', '/me', session.accessToken);
    expect(me.body).toMatchObject({ candidateId: invited.body.id, permissions: [] });
    expect((await call(h, 'GET', '/candidates', session.accessToken)).status).toBe(403);
  });

  it('self-registration on an approved domain requires email verification before approval', async () => {
    const org = await createOrg(h, { approvedEmailDomains: ['uni.example'] });
    const email = `${uniq('student')}@uni.example`;

    const reg = await call(h, 'POST', `/public/organisations/${org.slug}/register`, null, {
      email,
      fullName: 'John D.',
      password: PASSWORD,
    });
    expect(reg.body).toMatchObject({ status: 'registered', identityStatus: 'email_pending' });
    expect((await call(h, 'POST', `/candidates/${reg.body.candidateId}/approve`, org.owner, {})).status).toBe(409);

    const verified = await call(h, 'POST', '/public/verify-email', null, { token: await latestLinkToken(h, email) });
    expect(verified.body).toMatchObject({ status: 'pending_approval', identityStatus: 'verified' });
    expect((await call(h, 'POST', `/candidates/${reg.body.candidateId}/approve`, org.owner, {})).status).toBe(200);
  });

  it('routes personal email addresses to manual review instead of auto-approving', async () => {
    const org = await createOrg(h, { approvedEmailDomains: ['uni.example'] });
    const reg = await call(h, 'POST', `/public/organisations/${org.slug}/register`, null, {
      email: `${uniq('personal')}@gmail.example`,
      fullName: 'David K.',
      password: PASSWORD,
    });
    expect(reg.body).toMatchObject({ status: 'pending_approval', identityStatus: 'manual_review' });
  });

  it('will not link a registration to someone else’s existing account', async () => {
    const org = await createOrg(h);
    const other = await createOrg(h);
    const res = await call(h, 'POST', `/public/organisations/${other.slug}/register`, null, {
      email: org.ownerEmail,
      fullName: 'Impostor',
      password: 'a-different-password',
    });
    expect(res.status).toBe(409);
  });

  it('blocked candidates cannot sign in and lose unused entitlements', async () => {
    const org = await createOrg(h);
    const email = `${uniq('maria')}@${org.slug}.example`;
    const invited = await call(h, 'POST', '/candidates/invite', org.owner, { email, fullName: 'Maria' });
    await call(h, 'POST', '/public/invitations/accept', null, { token: await latestLinkToken(h, email), password: PASSWORD });
    await call(h, 'POST', `/candidates/${invited.body.id}/approve`, org.owner, {});
    const before = await login(h, org.slug, email);

    const blocked = await call(h, 'POST', `/candidates/${invited.body.id}/block`, org.owner, { reason: 'Policy' });
    expect(blocked.body.status).toBe('blocked');
    expect((await call(h, 'GET', '/me', before.accessToken)).status).toBe(401);
    expect(
      (await call(h, 'POST', '/auth/login', null, { organisation: org.slug, email, password: PASSWORD })).status,
    ).toBe(401);

    const unblocked = await call(h, 'POST', `/candidates/${invited.body.id}/unblock`, org.owner, {});
    expect(unblocked.body.status).toBe('pending_approval');
  });

  it('imports candidates in bulk and skips duplicates', async () => {
    const org = await createOrg(h);
    const dup = `${uniq('dup')}@${org.slug}.example`;
    await call(h, 'POST', '/candidates/invite', org.owner, { email: dup, fullName: 'Dup' });
    const res = await call(h, 'POST', '/candidates/import', org.owner, {
      candidates: [
        { email: `${uniq('a')}@${org.slug}.example`, fullName: 'A' },
        { email: dup.toUpperCase(), fullName: 'Dup again' },
        { email: `${uniq('b')}@${org.slug}.example`, fullName: 'B' },
      ],
    });
    expect(res.body).toEqual({ created: 2, skipped: [dup.toUpperCase()] });

    const list = await call(h, 'GET', '/candidates?status=invited&limit=2', org.owner);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.nextOffset).toBe(2);
  });
});
