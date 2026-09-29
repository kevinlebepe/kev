import { type FormEvent, useState } from 'react';
import { signIn } from '../lib/api';

export function Login({ onSignedIn, notice }: { onSignedIn: () => void; notice?: string | null }) {
  const [organisation, setOrganisation] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(notice ?? null);
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
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
