import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { rememberedOrganisation } from '../lib/brand';
import { request } from '../lib/api';

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="centered">
      <section className="card login" aria-labelledby="onboarding-title">
        <p className="brand">ExamGuard</p>
        <h1 id="onboarding-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

const PASSWORD_HINT = 'At least 12 characters. A short sentence is easy to remember and hard to guess.';

function PasswordFields({ password, setPassword, confirm, setConfirm }: { password: string; setPassword: (v: string) => void; confirm: string; setConfirm: (v: string) => void }) {
  return (
    <>
      <label>
        Choose a password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required autoComplete="new-password" aria-describedby="pw-hint" />
      </label>
      <p id="pw-hint" className="muted small">
        {PASSWORD_HINT}
      </p>
      <label>
        Type it again
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={12} required autoComplete="new-password" />
      </label>
    </>
  );
}

function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, submit };
}

/** From the invitation email: the candidate sets a password and waits for approval. */
export function AcceptInvitation({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accepted, setAccepted] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    if (password !== confirm) throw new Error('The two passwords do not match.');
    await request('POST', '/public/invitations/accept', { token, password });
    setAccepted(true);
  });

  if (accepted) {
    return (
      <Frame title="Invitation accepted">
        <p className="banner ok" role="status">
          ✓ Your account is ready.
        </p>
        <p>Your organisation still has to approve it. Once they do, and assign an exam, it appears when you sign in.</p>
        <button className="primary" onClick={onDone}>
          Go to sign in
        </button>
      </Frame>
    );
  }
  return (
    <Frame title="Accept your invitation">
      <form onSubmit={submit}>
        <p>Choose a password to finish setting up your ExamGuard account.</p>
        <PasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Accept invitation'}
        </button>
        <p className="help">If you already have an ExamGuard account with this email, enter that password instead.</p>
      </form>
    </Frame>
  );
}

/** From the password reset email. */
export function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    if (password !== confirm) throw new Error('The two passwords do not match.');
    await request('POST', '/public/password-reset/complete', { token, password });
    setDone(true);
  });
  if (done) {
    return (
      <Frame title="Password changed">
        <p className="banner ok" role="status">
          ✓ Your password has been changed, and you have been signed out everywhere else.
        </p>
        <button className="primary" onClick={onDone}>
          Go to sign in
        </button>
      </Frame>
    );
  }
  return (
    <Frame title="Choose a new password">
      <form onSubmit={submit}>
        <PasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </Frame>
  );
}

/** From the confirmation email after registering with an approved email domain. */
export function VerifyEmail({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, setState] = useState<'working' | 'done' | string>('working');
  const started = useRef(false);
  useEffect(() => {
    // The link works once, so a second run in development's strict mode must not use it again.
    if (started.current) return;
    started.current = true;
    request('POST', '/public/verify-email', { token })
      .then(() => setState('done'))
      .catch((err: Error) => setState(err.message));
  }, [token]);

  return (
    <Frame title="Confirm your email">
      {state === 'working' && <p role="status">Confirming…</p>}
      {state === 'done' && (
        <>
          <p className="banner ok" role="status">
            ✓ Your email address is confirmed.
          </p>
          <p>Your organisation approves your account next. Exams appear when you sign in once one is assigned.</p>
        </>
      )}
      {state !== 'working' && state !== 'done' && (
        <p className="error" role="alert">
          {state}
        </p>
      )}
      <button className="primary" onClick={onDone} disabled={state === 'working'}>
        Go to sign in
      </button>
    </Frame>
  );
}

/** Self registration for organisations that allow it. */
export function Register({ organisation: initial, onDone }: { organisation: string | null; onDone: () => void }) {
  const [organisation, setOrganisation] = useState(initial ?? rememberedOrganisation());
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [studentId, setStudentId] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [outcome, setOutcome] = useState<{ status: string; identityStatus: string } | null>(null);
  const { busy, error, submit } = useSubmit(async () => {
    if (password !== confirm) throw new Error('The two passwords do not match.');
    const slug = organisation.trim().toLowerCase();
    const res = await request<{ status: string; identityStatus: string }>('POST', `/public/organisations/${encodeURIComponent(slug)}/register`, {
      fullName: fullName.trim(),
      email: email.trim(),
      password,
      ...(studentId.trim() ? { studentId: studentId.trim() } : {}),
    });
    setOutcome(res);
  });

  if (outcome) {
    return (
      <Frame title="Registration received">
        {outcome.identityStatus === 'email_pending' ? (
          <p>We have sent you an email. Follow the link in it to confirm your address. Your organisation approves your account after that.</p>
        ) : (
          <p>Your organisation checks new registrations by hand. You can sign in now, and your exams appear once they approve you.</p>
        )}
        <button className="primary" onClick={onDone}>
          Go to sign in
        </button>
      </Frame>
    );
  }
  return (
    <Frame title="Create an account">
      <form onSubmit={submit}>
        <label>
          Institution or organisation
          <input value={organisation} onChange={(e) => setOrganisation(e.target.value)} placeholder="The code your organisation gave you" required />
        </label>
        <label>
          Full name
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} required autoComplete="name" />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Student or staff number (optional)
          <input value={studentId} onChange={(e) => setStudentId(e.target.value)} />
        </label>
        <PasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <p className="help">
          Already have an account?{' '}
          <button type="button" className="link" onClick={onDone}>
            Sign in
          </button>
        </p>
      </form>
    </Frame>
  );
}
