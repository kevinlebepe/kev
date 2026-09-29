import { describe, expect, it } from 'vitest';
import { totpAt, currentStep } from '../src/auth/totp.js';
import { call, createOrg, latestLinkToken, login, PASSWORD, type TestOrg, uniq, useHarness } from './helpers.js';

const h = useHarness();

async function staff(org: TestOrg, role = 'exam_manager') {
  const email = `${uniq('staff')}@${org.slug}.example`;
  await call(h, 'POST', `/organisations/${org.id}/users`, org.owner, { email, displayName: 'Staff', role, password: PASSWORD });
  return email;
}

const attempt = (org: TestOrg, email: string, password = PASSWORD) => call(h, 'POST', '/auth/login', null, { organisation: org.slug, email, password });

/** Turns on two factor sign in for a user and returns the secret and recovery codes. */
async function enrol(token: string) {
  const setup = await call(h, 'POST', '/me/mfa/setup', token);
  expect(setup.status).toBe(200);
  const code = totpAt(setup.body.secret, currentStep());
  const enabled = await call(h, 'POST', '/me/mfa/enable', token, { code });
  expect(enabled.status).toBe(200);
  return { secret: setup.body.secret as string, recoveryCodes: enabled.body.recoveryCodes as string[] };
}

describe('account lockout', () => {
  it('locks after 5 wrong passwords, refuses even the right one, with one message throughout', async () => {
    const org = await createOrg(h);
    const email = await staff(org);
    const messages = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = await attempt(org, email, 'wrong password 123');
      expect(r.status).toBe(401);
      messages.add(r.body.error.message);
    }
    const locked = await attempt(org, email);
    expect(locked.status).toBe(401);
    messages.add(locked.body.error.message);
    messages.add((await attempt(org, `nobody-${Date.now()}@x.example`)).body.error.message);
    expect(messages.size).toBe(1);

    await h.db.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE lower(email) = lower($1)`, [email]);
    expect((await attempt(org, email)).status).toBe(200);
    const { rows } = await h.db.query(`SELECT action FROM audit_logs WHERE action = 'auth.locked' AND actor_user_id = (SELECT id FROM users WHERE email = $1)`, [email]);
    expect(rows).toHaveLength(1);
  });

  it('forgives failures once a sign in succeeds', async () => {
    const org = await createOrg(h);
    const email = await staff(org);
    for (let i = 0; i < 4; i++) await attempt(org, email, 'wrong password 123');
    expect((await attempt(org, email)).status).toBe(200);
    for (let i = 0; i < 4; i++) await attempt(org, email, 'wrong password 123');
    expect((await attempt(org, email)).status).toBe(200);
  });
});

describe('two factor sign in', () => {
  it('asks for a code after the password, and a code works once', async () => {
    const org = await createOrg(h);
    const email = await staff(org);
    const { secret } = await enrol((await login(h, org.slug, email)).accessToken);

    const first = await attempt(org, email);
    expect(first.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(first.body.accessToken).toBeUndefined();
    // The ticket is not an access token.
    expect((await call(h, 'GET', '/me', first.body.mfaToken)).status).toBe(401);

    // Enrolment used the current code; the next one is accepted, allowing for clock drift.
    const code = totpAt(secret, currentStep() + 1);
    const done = await call(h, 'POST', '/auth/mfa', null, { mfaToken: first.body.mfaToken, code });
    expect(done.status).toBe(200);
    expect((await call(h, 'GET', '/me', done.body.accessToken)).body.mfaEnabled).toBe(true);

    const again = await attempt(org, email);
    expect((await call(h, 'POST', '/auth/mfa', null, { mfaToken: again.body.mfaToken, code })).status).toBe(401);
  });

  it('takes a recovery code once, and wrong codes count towards the lockout', async () => {
    const org = await createOrg(h);
    const email = await staff(org);
    const { recoveryCodes } = await enrol((await login(h, org.slug, email)).accessToken);
    const t1 = (await attempt(org, email)).body.mfaToken;
    expect((await call(h, 'POST', '/auth/mfa', null, { mfaToken: t1, code: recoveryCodes[0]!.toUpperCase() })).status).toBe(200);
    const t2 = (await attempt(org, email)).body.mfaToken;
    expect((await call(h, 'POST', '/auth/mfa', null, { mfaToken: t2, code: recoveryCodes[0] })).status).toBe(401);

    // Knowing the password does not reset the count of wrong codes.
    for (let i = 0; i < 4; i++) {
      const t = (await attempt(org, email)).body.mfaToken;
      await call(h, 'POST', '/auth/mfa', null, { mfaToken: t, code: '000000' });
    }
    const t3 = (await attempt(org, email)).body.mfaToken;
    expect(t3).toBeUndefined();
  });

  it('turns off only with a valid code', async () => {
    const org = await createOrg(h);
    const email = await staff(org);
    const token = (await login(h, org.slug, email)).accessToken;
    const { secret } = await enrol(token);
    expect((await call(h, 'POST', '/me/mfa/disable', token, { code: '123456' })).status).toBe(400);
    const code = totpAt(secret, currentStep() + 1);
    expect((await call(h, 'POST', '/me/mfa/disable', token, { code })).body.enabled).toBe(false);
    expect((await attempt(org, email)).body.accessToken).toBeTruthy();
  });

  it('when the organisation requires it, gives staff no access until they turn it on', async () => {
    const org = await createOrg(h);
    const email = await staff(org);
    expect((await call(h, 'PATCH', `/organisations/${org.id}`, org.owner, { requireStaffMfa: true })).body.requireStaffMfa).toBe(true);
    const token = (await login(h, org.slug, email)).accessToken;
    const me = await call(h, 'GET', '/me', token);
    expect(me.body).toMatchObject({ mfaSetupRequired: true, permissions: [] });
    expect((await call(h, 'GET', '/exams', token)).status).toBe(403);

    const { secret } = await enrol(token);
    const t = (await attempt(org, email)).body.mfaToken;
    const full = await call(h, 'POST', '/auth/mfa', null, { mfaToken: t, code: totpAt(secret, currentStep() + 1) });
    expect((await call(h, 'GET', '/exams', full.body.accessToken)).status).toBe(200);
    expect((await call(h, 'POST', '/me/mfa/disable', full.body.accessToken, { code: totpAt(secret, currentStep() - 1) })).status).toBe(409);
  });
});

describe('emailed links', () => {
  it('invites new staff to choose a password, once', async () => {
    const org = await createOrg(h);
    const email = `${uniq('new')}@${org.slug}.example`;
    const added = await call(h, 'POST', `/organisations/${org.id}/users`, org.owner, { email, displayName: 'New', role: 'reviewer' });
    expect(added.body.invited).toBe(true);
    expect((await attempt(org, email)).status).toBe(401);
    const token = await latestLinkToken(h, email);
    const accepted = await call(h, 'POST', '/public/staff-invitations/accept', null, { token, password: 'my new staff password' });
    expect(accepted.body).toEqual({ email, organisation: org.slug });
    expect((await attempt(org, email, 'my new staff password')).status).toBe(200);
    expect((await call(h, 'POST', '/public/staff-invitations/accept', null, { token, password: 'another password 1' })).status).toBe(400);
  });

  it('invites new invigilators the same way', async () => {
    const org = await createOrg(h);
    const email = `${uniq('inv')}@${org.slug}.example`;
    const res = await call(h, 'POST', '/invigilators', org.owner, { email, displayName: 'Inv' });
    expect(res.body.invited).toBe(true);
    const { rows } = await h.db.query(`SELECT payload->>'link' AS link FROM notifications WHERE recipient_email = $1 AND kind = 'staff_invitation'`, [email]);
    expect(rows[0].link).toMatch(new RegExp(`^${h.config.portalBaseUrl}/#/invitation/`));
  });

  it('resets a password by email, signs out everywhere and unlocks the account', async () => {
    const org = await createOrg(h);
    const email = await staff(org);
    const session = await login(h, org.slug, email);
    for (let i = 0; i < 5; i++) await attempt(org, email, 'wrong password 123');

    const ask = await call(h, 'POST', '/public/password-reset', null, { email, app: 'staff' });
    const unknown = await call(h, 'POST', '/public/password-reset', null, { email: `nobody-${Date.now()}@x.example` });
    expect(ask.status).toBe(202);
    expect(unknown.body).toEqual(ask.body);

    const token = await latestLinkToken(h, email);
    expect((await call(h, 'POST', '/public/password-reset/complete', null, { token, password: 'short' })).status).toBe(400);
    expect((await call(h, 'POST', '/public/password-reset/complete', null, { token, password: 'a brand new password' })).status).toBe(200);
    expect((await attempt(org, email, 'a brand new password')).status).toBe(200);
    expect((await call(h, 'POST', '/auth/refresh', null, { refreshToken: session.refreshToken })).status).toBe(401);
    expect((await call(h, 'POST', '/public/password-reset/complete', null, { token, password: 'yet another password' })).status).toBe(400);
  });
});
