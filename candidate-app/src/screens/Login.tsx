import { type FormEvent, useState } from 'react';
import { completeMfa, request, signIn } from '../lib/api';

type Step = { name: 'password' } | { name: 'code'; mfaToken: string } | { name: 'forgot' } | { name: 'sent'; message: string };

export function Login({ onSignedIn, onRegister }: { onSignedIn: () => void; onRegister?: () => void }) {
  const [step, setStep] = useState<Step>({ name: 'password' });
  const [organisation, setOrganisation] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  const back = (
    <p className="help">
      <button type="button" className="link" onClick={() => setStep({ name: 'password' })}>
        Back to sign in
      </button>
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
          <p>Type the 6 digit code from your authenticator app, or one of your recovery codes.</p>
          <label>
            Code
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required />
          </label>
          {errorText}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
          {back}
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
              const res = await request<{ message: string }>('POST', '/public/password-reset', { email: email.trim(), app: 'candidate' });
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
              <p>We will email you a link to choose a new password. It works for one hour.</p>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
              </label>
              {errorText}
              <button className="primary" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a link'}
              </button>
            </>
          )}
          {back}
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
        <h1 id="login-title">Sign in</h1>

        <label>
          Institution or organisation
          <input value={organisation} onChange={(e) => setOrganisation(e.target.value)} placeholder="e.g. demo-uni" required autoComplete="organization" />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>

        {errorText}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Continue'}
        </button>

        <p className="help">
          <button type="button" className="link" onClick={() => setStep({ name: 'forgot' })}>
            Forgot your password?
          </button>
        </p>
        <p className="help">
          Need help? Contact your organisation’s exam support. Complete your device check well before exam day.
        </p>
        {onRegister && (
          <p className="help">
            New here and not invited?{' '}
            <button type="button" className="link" onClick={onRegister}>
              Create an account
            </button>
          </p>
        )}
      </form>
    </main>
  );
}
