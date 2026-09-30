import { type FormEvent, useState } from 'react';
import { request } from '../lib/api';

// Pages opened from emailed links, before anyone is signed in.

function SetPassword({
  title,
  intro,
  submitText,
  onSubmit,
  done,
}: {
  title: string;
  intro: string;
  submitText: string;
  onSubmit: (password: string) => Promise<string>;
  done: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      setFinished(await onSubmit(password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="centered">
      <form className="card login" onSubmit={submit} aria-labelledby="public-title">
        <p className="brand">EXAMGUARD</p>
        <h1 id="public-title">{title}</h1>
        {finished ? (
          <>
            <p className="banner ok" role="status">
              {finished}
            </p>
            <button type="button" className="primary" onClick={done}>
              Go to sign in
            </button>
          </>
        ) : (
          <>
            <p className="muted">{intro}</p>
            <label className="field">
              <span>New password</span>
              <input type="password" value={password} minLength={12} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
              <small className="muted">At least 12 characters. A short sentence is easy to remember and hard to guess.</small>
            </label>
            <label className="field">
              <span>Type it again</span>
              <input type="password" value={confirm} minLength={12} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : submitText}
            </button>
          </>
        )}
      </form>
    </main>
  );
}

/** Leaves the emailed page: the used link must not stay in the address bar. */
function toSignIn() {
  window.location.hash = '';
  window.location.reload();
}

export function AcceptStaffInvitation({ token }: { token: string }) {
  return (
    <SetPassword
      title="Welcome to ExamGuard"
      intro="Choose a password to finish setting up your staff account."
      submitText="Save password"
      onSubmit={async (password) => {
        const res = await request<{ email: string; organisation: string | null }>('POST', '/public/staff-invitations/accept', { token, password });
        return `Your account is ready. Sign in with ${res.email}${res.organisation ? ` and the organisation code ${res.organisation}` : ''}.`;
      }}
      done={toSignIn}
    />
  );
}

export function ResetPassword({ token }: { token: string }) {
  return (
    <SetPassword
      title="Choose a new password"
      intro="Choose a new password. You will be signed out on every device."
      submitText="Save new password"
      onSubmit={async (password) => {
        await request('POST', '/public/password-reset/complete', { token, password });
        return 'Your password has been changed.';
      }}
      done={toSignIn}
    />
  );
}
