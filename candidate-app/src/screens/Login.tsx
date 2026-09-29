import { type FormEvent, useState } from 'react';
import { signIn } from '../lib/api';

export function Login({ onSignedIn, onRegister }: { onSignedIn: () => void; onRegister?: () => void }) {
  const [organisation, setOrganisation] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(organisation.trim(), email.trim(), password);
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="centered">
      <form className="card login" onSubmit={submit} aria-labelledby="login-title">
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

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Continue'}
        </button>

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
