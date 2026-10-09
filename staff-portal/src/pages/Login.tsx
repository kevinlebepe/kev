import { type FormEvent, useEffect, useState } from 'react';
import { completeMfa, request, signIn, ssoStartUrl } from '../lib/api';

type Step = { name: 'password' } | { name: 'code'; mfaToken: string } | { name: 'forgot' } | { name: 'sent'; message: string };

export function Login({ onSignedIn, notice }: { onSignedIn: () => void; notice?: string | null }) {
  const [step, setStep] = useState<Step>({ name: 'password' });
  const [organisation, setOrganisation] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(notice ?? null);
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<{ id: string; name: string }[]>([]);
  // Once the organisation code is typed, offer its single sign on, if any.
  useEffect(() => {
    const slug = organisation.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      setSso([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      request<{ sso: { id: string; name: string; forStaff: boolean }[] }>('GET', `/public/organisations/${slug}/branding`)
        .then((b) => !stale && setSso(b.sso.filter((p) => p.forStaff)))
        .catch(() => !stale && setSso([]));
    }, 400);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [organisation]);

  async function run(e: FormEvent, action: () => Promise<void>) {
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

  const errorText = error && (
    <p className="error" role="alert">
      {error}
    </p>
  );

  if (step.name === 'code') {
    return (
      <main className="centered">
        <form
          className="card login"
          aria-labelledby="login-title"
          onSubmit={(e) =>
            run(e, async () => {
              await completeMfa(step.mfaToken, code.trim());
              onSignedIn();
            })
          }
        >
          <p className="brand">EXAMGUARD</p>
          <h1 id="login-title">Enter your code</h1>
          <p className="muted">Open your authenticator app and type the 6 digit code for ExamGuard. Lost your phone? Type one of your recovery codes instead.</p>
          <label className="field">
            <span>Code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required />
          </label>
          {errorText}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <p>
            <button type="button" className="link" onClick={() => setStep({ name: 'password' })}>
              Start again
            </button>
          </p>
        </form>
      </main>
    );
  }

  if (step.name === 'forgot' || step.name === 'sent') {
    return (
      <main className="centered">
        <form
          className="card login"
          aria-labelledby="login-title"
          onSubmit={(e) =>
            run(e, async () => {
              const res = await request<{ message: string }>('POST', '/public/password-reset', { email: email.trim(), app: 'staff' });
              setStep({ name: 'sent', message: res.message });
            })
          }
        >
          <p className="brand">EXAMGUARD</p>
          <h1 id="login-title">Forgot your password</h1>
          {step.name === 'sent' ? (
            <p className="banner ok" role="status">
              {step.message}
            </p>
          ) : (
            <>
              <p className="muted">We will email you a link to choose a new one. It works for one hour.</p>
              <label className="field">
                <span>Email</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
              </label>
              {errorText}
              <button className="primary" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a link'}
              </button>
            </>
          )}
          <p>
            <button type="button" className="link" onClick={() => setStep({ name: 'password' })}>
              Back to sign in
            </button>
          </p>
        </form>
      </main>
    );
  }

  return (
    <main className="centered">
      <form
        className="card login"
        aria-labelledby="login-title"
        onSubmit={(e) =>
          run(e, async () => {
            const result = await signIn(organisation.trim(), email.trim(), password);
            if (result.mfaToken) {
              setCode('');
              setStep({ name: 'code', mfaToken: result.mfaToken });
            } else onSignedIn();
          })
        }
      >
        <p className="brand">EXAMGUARD</p>
        <h1 id="login-title">Staff sign in</h1>
        <p className="muted">For administrators, exam managers, invigilators and markers.</p>
        <label className="field">
          <span>Organisation</span>
          <input value={organisation} onChange={(e) => setOrganisation(e.target.value)} placeholder="e.g. demo-uni" required autoComplete="organization" />
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        {errorText}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p>
          <button type="button" className="link" onClick={() => setStep({ name: 'forgot' })}>
            Forgot your password?
          </button>
        </p>
        {sso.map((p) => (
          <a key={p.id} className="button" href={ssoStartUrl(p.id, 'portal')}>
            Sign in with {p.name}
          </a>
        ))}
      </form>
    </main>
  );
}
