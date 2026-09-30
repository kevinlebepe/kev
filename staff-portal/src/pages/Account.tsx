import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { ActionButton, ErrorText, Field, Form, Page } from '../components/ui';
import { request } from '../lib/api';
import { useMe } from '../lib/session';

/** Turns two factor sign in on and off. Shown on its own when the organisation requires it. */
export function TwoFactor({ enabled, required, onChanged }: { enabled: boolean; required: boolean; onChanged: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);

  useEffect(() => {
    if (!setup) return setQr(null);
    QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 220 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [setup]);

  if (recovery) {
    return (
      <section className="card">
        <h2>Two factor sign in is on</h2>
        <p>Keep these recovery codes somewhere safe, apart from your phone. Each one works once if you lose your phone. They are not shown again.</p>
        <ul className="recovery">
          {recovery.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
        <button
          className="primary"
          onClick={() => {
            setRecovery(null);
            setSetup(null);
            setCode('');
            onChanged();
          }}
        >
          I have saved them
        </button>
      </section>
    );
  }

  if (enabled) {
    return (
      <Form
        submitText="Turn off two factor sign in"
        onSubmit={async () => {
          await request('POST', '/me/mfa/disable', { code: code.trim() });
          setCode('');
          onChanged();
        }}
      >
        <h2>Two factor sign in</h2>
        <p className="banner ok">✓ On. Signing in needs your password and a code from your authenticator app.</p>
        {required ? (
          <p className="muted">Your organisation requires it for staff, so it cannot be turned off.</p>
        ) : (
          <Field label="To turn it off, enter a current code or a recovery code">
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required />
          </Field>
        )}
      </Form>
    );
  }

  return (
    <section className="card">
      <h2>Two factor sign in</h2>
      <p>
        Adds a second step to signing in: a 6 digit code from an authenticator app on your phone, such as Google Authenticator or Microsoft Authenticator.
        Someone who learns your password still cannot sign in.
      </p>
      {!setup ? (
        <ActionButton className="primary" onClick={async () => setSetup(await request('POST', '/me/mfa/setup'))}>
          Set up two factor sign in
        </ActionButton>
      ) : (
        <Form
          submitText="Turn on"
          onSubmit={async () => {
            const res = await request<{ recoveryCodes: string[] }>('POST', '/me/mfa/enable', { code: code.trim() });
            setRecovery(res.recoveryCodes);
          }}
        >
          <ol className="steps">
            <li>In your authenticator app, add an account and scan this code.</li>
            <li>Type the 6 digit code the app shows.</li>
          </ol>
          {qr && <img className="qr" src={qr} alt="QR code for your authenticator app" width={220} height={220} />}
          <p className="muted small">
            Cannot scan? Enter this key instead: <code className="secret-inline">{setup.secret}</code>
          </p>
          <Field label="Code from the app">
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
          </Field>
        </Form>
      )}
    </section>
  );
}

export function Account({ onChanged }: { onChanged: () => void }) {
  const me = useMe();
  const [error] = useState<string | null>(null);
  return (
    <Page title="Your account">
      <ErrorText error={error} />
      <p>
        {me.user.display_name} · {me.user.email}
      </p>
      <TwoFactor enabled={me.mfaEnabled} required={me.mfaRequiredByOrganisation ?? false} onChanged={onChanged} />
    </Page>
  );
}

/** Shown instead of the portal when the organisation requires two factor sign in and it is not on yet. */
export function TwoFactorRequired({ onChanged, onSignOut }: { onChanged: () => void; onSignOut: () => void }) {
  return (
    <main className="content narrow">
      <p className="brand">EXAMGUARD</p>
      <h1>Turn on two factor sign in</h1>
      <p>Your organisation requires two factor sign in for staff. Set it up to continue.</p>
      <TwoFactor enabled={false} required onChanged={onChanged} />
      <button className="link" onClick={onSignOut}>
        Sign out
      </button>
    </main>
  );
}
