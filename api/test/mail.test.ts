import { describe, expect, it } from 'vitest';
import { deliverEmails, type MailMessage, MAX_ATTEMPTS, render } from '../src/mail.js';
import { call, createOrg, useHarness } from './helpers.js';

const h = useHarness();

function capture(fail?: (m: MailMessage) => boolean) {
  const sent: MailMessage[] = [];
  return {
    sent,
    transport: {
      async send(m: MailMessage) {
        if (fail?.(m)) throw new Error('mail server said no');
        sent.push(m);
      },
    },
  };
}

/** Other test files write notifications too, so keep delivering until the queue is empty. */
async function drain(transport: { send(m: MailMessage): Promise<void> }) {
  for (let i = 0; i < 50; i++) if ((await deliverEmails(h.db, h.config, transport, 200)).sent === 0) break;
}

describe('email delivery', () => {
  it('sends the invitation once, with its link, then removes the link from storage', async () => {
    const org = await createOrg(h);
    const email = `mail-${Date.now()}@${org.slug}.example`;
    await call(h, 'POST', '/candidates/invite', org.owner, { email, fullName: 'Lerato Mail' });

    const mail = capture();
    await drain(mail.transport);
    const mine = mail.sent.filter((m) => m.to === email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toMatch(/invites you/);
    expect(mine[0]!.text).toMatch(/Hello Lerato Mail/);
    expect(mine[0]!.text).toMatch(new RegExp(`${h.config.publicBaseUrl}/invitation/\\S+`));

    const { rows } = await h.db.query(`SELECT sent_at, payload FROM notifications WHERE recipient_email = $1`, [email]);
    expect(rows[0].sent_at).not.toBeNull();
    expect(rows[0].payload.link).toBeUndefined();

    const again = capture();
    await drain(again.transport);
    expect(again.sent.filter((m) => m.to === email)).toEqual([]);
  });

  it('keeps a failed email for another try, and gives up after too many', async () => {
    const org = await createOrg(h);
    const email = `bounce-${Date.now()}@${org.slug}.example`;
    await call(h, 'POST', '/candidates/invite', org.owner, { email, fullName: 'Bounce' });
    const failing = capture((m) => m.to === email);
    await drain(failing.transport);
    let { rows } = await h.db.query(`SELECT attempts, sent_at, failed_at, last_error, payload FROM notifications WHERE recipient_email = $1`, [email]);
    expect(rows[0]).toMatchObject({ attempts: 1, sent_at: null, failed_at: null, last_error: 'mail server said no' });
    expect(rows[0].payload.link).toBeDefined();

    // Pretend enough time passed for every retry.
    await h.db.query(`UPDATE notifications SET created_at = now() - interval '1 year', attempts = $2 WHERE recipient_email = $1`, [email, MAX_ATTEMPTS - 1]);
    await drain(failing.transport);
    ({ rows } = await h.db.query(`SELECT attempts, failed_at, payload FROM notifications WHERE recipient_email = $1`, [email]));
    expect(rows[0].attempts).toBe(MAX_ATTEMPTS);
    expect(rows[0].failed_at).not.toBeNull();
    expect(rows[0].payload.link).toBeUndefined();
  });

  it('never sends the same email twice when two workers run at once', async () => {
    const org = await createOrg(h);
    const email = `race-${Date.now()}@${org.slug}.example`;
    await call(h, 'POST', '/candidates/invite', org.owner, { email, fullName: 'Race' });
    const a = capture();
    const b = capture();
    await Promise.all([drain(a.transport), drain(b.transport)]);
    expect([...a.sent, ...b.sent].filter((m) => m.to === email)).toHaveLength(1);
  });

  it('writes the exam and result emails with the session name', () => {
    const row = { id: 'x', to: 'a@b.c', organisation_name: 'Wits', session_name: 'Maths final', starts_at: new Date('2030-10-14T07:00:00Z'), payload: {} };
    const assigned = render({ ...row, kind: 'exam_assigned' }, h.config)!;
    expect(assigned.subject).toBe('New exam: Maths final');
    expect(assigned.text).toMatch(/Monday, 14 October 2030 at 09:00/);
    expect(render({ ...row, kind: 'result_released' }, h.config)!.text).toMatch(/My results/);
    expect(render({ ...row, kind: 'readiness_failure' }, h.config)).toBeNull();
    expect(render({ ...row, kind: 'candidate_invitation' }, h.config)).toBeNull();
  });
});
