import { type FormEvent, useEffect, useState } from 'react';
import { API_BASE, completeMfa, request, signIn, signInWithAccessCode, ssoStartUrl } from '../lib/api';

type Step = { name: 'password' } | { name: 'code'; mfaToken: string } | { name: 'forgot' } | { name: 'sent'; message: string } | { name: 'access-code' };

interface Branding {
  name: string;
  colour: string | null;
  logo: boolean;
  accessCodes: boolean;
  sso: { id: string; name: string; forCandidates: boolean }[];
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Black or white, whichever reads better on a #rrggbb background (WCAG relative luminance). */
export function textOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

/**
 * The organisation's name, logo and colour once its code is typed, so a
 * candidate can see they are signing in to the right place (spec section 5).
 */
function useBranding(organisation: string): Branding | null {
  const [branding, setBranding] = useState<Branding | null>(null);
  useEffect(() => {
    const slug = organisation.trim().toLowerCase();
    if (!SLUG.test(slug)) {
      setBranding(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      request<Branding>('GET', `/public/organisations/${slug}/branding`)
        .then((b) => !stale && setBranding(b))
        .catch(() => !stale && setBranding(null));
    }, 400);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [organisation]);
  useEffect(() => {
    // The organisation's colour becomes the app's accent until the page is closed.
    const root = document.documentElement.style;
    if (branding?.colour) {
      root.setProperty('--accent', branding.colour);
      root.setProperty('--accent-text', textOn(branding.colour));
    } else {
      root.removeProperty('--accent');
      root.removeProperty('--accent-text');
    }
  }, [branding?.colour]);
  return branding;
}

export function Login({ onSignedIn, onRegister, notice = null }: { onSignedIn: () => void; onRegister?: () => void; notice?: string | null }) {
  const [step, setStep] = useState<Step>({ name: 'password' });
  const [organisation, setOrganisation] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(notice);
  const [busy, setBusy] = useState(false);
  const [accessCode, setAccessCode] = useState('');
  const branding = useBranding(organisation);
  const slug = organisation.trim().toLowerCase();
  const header = (
    <>
      <p className="brand">EXAMGUARD</p>
      {branding && (
        <p className="org-brand">
          {branding.logo && <img src={`${API_BASE}/public/organisations/${slug}/logo`} alt="" />}
          <span>{branding.name}</span>
        </p>
      )}
    </>
  );

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

  if (step.name === 'access-code') {
    return (
      <main className="centered">
        <form
          className="card login"
          aria-labelledby="login-title"
          onSubmit={(e) =>
            run(e, async () => {
              await signInWithAccessCode(slug, accessCode.trim());
              onSignedIn();
            })
          }
        >
          {header}
          <h1 id="login-title">Sign in with an exam access code</h1>
          <p>Use this only if your organisation gave you a code for today’s exam. It works from an hour before the exam until it ends.</p>
          <label>
            Institution or organisation
            <input value={organisation} onChange={(e) => setOrganisation(e.target.value)} required autoComplete="organization" />
          </label>
          <label>
            Access code
            <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="ABCD-EFGH-JKLM" autoComplete="one-time-code" required />
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
        {header}
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
        {branding?.sso
          .filter((p) => p.forCandidates)
          .map((p) => (
            <a key={p.id} className="button sso" href={ssoStartUrl(p.id)}>
              Sign in with {p.name}
            </a>
          ))}
        {branding?.accessCodes && (
          <p className="help">
            <button type="button" className="link" onClick={() => setStep({ name: 'access-code' })}>
              Use an exam access code
            </button>
          </p>
        )}
        <p className="help">
          Need help? Contact your organisation’s exam support. Complete your device check well before exam day.
        </p>
        <p className="help">
          <a href="/status">System status</a>
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
