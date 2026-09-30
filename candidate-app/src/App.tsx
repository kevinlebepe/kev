import { useCallback, useEffect, useRef, useState } from 'react';
import { completeSso, request, resumeSession, signOut } from './lib/api';
import { examFromSearch } from './lib/launch';
import { onboardingRoute } from './lib/onboarding';
import { SystemStatus } from './screens/SystemStatus';
import { Help } from './screens/Help';
import { AcceptInvitation, Register, ResetPassword, VerifyEmail } from './screens/Onboarding';
import type { Entitlement } from './lib/types';
import { currentBridge } from './device/bridge';
import { Login } from './screens/Login';
import { Entitlements } from './screens/Entitlements';
import { DeviceCheck } from './screens/DeviceCheck';
import { ExamView } from './screens/ExamView';
import { type ReleasedResult, Results } from './screens/Results';
import { BrandContext, BrandMark, useOrgBrand } from './lib/brand';

type Screen =
  | { name: 'starting' }
  | { name: 'login' }
  | { name: 'home' }
  | { name: 'check'; entitlement: Entitlement }
  | { name: 'exam'; entitlement: Entitlement }
  | { name: 'help'; preset?: { category?: string; entitlementId?: string } };

export function App() {
  // A link from an onboarding email opens its screen before anything else.
  const [onboarding, setOnboarding] = useState(() => onboardingRoute(window.location.pathname));
  const [screen, setScreen] = useState<Screen>({ name: 'starting' });
  const [items, setItems] = useState<Entitlement[]>([]);
  const [results, setResults] = useState<ReleasedResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  // An exam named in the address, for example when the desktop application was opened from a link.
  const requestedExam = useRef<string | null>(examFromSearch(window.location.search));

  const load = useCallback(async () => {
    try {
      const [data, released] = await Promise.all([
        request<{ items: Entitlement[] }>('GET', '/me/entitlements'),
        // Results are extra: the exams list still works if they cannot be loaded.
        request<{ items: ReleasedResult[] }>('GET', '/me/results').catch(() => ({ items: [] })),
      ]);
      setItems(data.items);
      setResults(released.items);
      setError(null);
      // Go straight to the exam the link named: its rules if the device is ready, otherwise its device check.
      const wanted = requestedExam.current ? data.items.find((i) => i.id === requestedExam.current) : undefined;
      if (wanted && ['assigned', 'precheck_complete', 'active'].includes(wanted.status)) {
        requestedExam.current = null;
        window.history.replaceState(null, '', window.location.pathname);
        setScreen(wanted.status === 'assigned' ? { name: 'check', entitlement: wanted } : { name: 'exam', entitlement: wanted });
        return;
      }
      setScreen({ name: 'home' });
    } catch (err) {
      setError((err as Error).message);
      setScreen({ name: 'login' });
    }
  }, []);

  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (onboarding) return;
    // Back from single sign on: swap the one time code for a session, then tidy the address.
    const params = new URLSearchParams(window.location.search);
    const ssoCode = params.get('sso');
    const ssoError = params.get('sso_error');
    if (ssoCode || ssoError) window.history.replaceState(null, '', window.location.pathname);
    if (ssoError) setNotice(ssoError);
    const start = ssoCode ? completeSso(ssoCode).then(() => true, (err: Error) => (setNotice(err.message), false)) : resumeSession();
    start.then((ok) => (ok ? load() : setScreen({ name: 'login' })));
  }, [load, onboarding]);

  const signedIn = !['starting', 'login'].includes(screen.name);
  const brand = useOrgBrand(signedIn);

  const toSignIn = () => {
    // The token must not stay in the address bar or the history once used.
    window.history.replaceState(null, '', '/');
    setOnboarding(null);
    setScreen({ name: 'login' });
  };
  if (onboarding?.kind === 'invitation') return <AcceptInvitation token={onboarding.token} onDone={toSignIn} />;
  if (onboarding?.kind === 'verify-email') return <VerifyEmail token={onboarding.token} onDone={toSignIn} />;
  if (onboarding?.kind === 'register') return <Register organisation={onboarding.organisation} onDone={toSignIn} />;
  if (onboarding?.kind === 'reset-password') return <ResetPassword token={onboarding.token} onDone={toSignIn} />;
  if (onboarding?.kind === 'status') return <SystemStatus onDone={toSignIn} />;

  if (screen.name === 'starting') return <main className="centered">Starting…</main>;
  if (screen.name === 'login') return <Login onSignedIn={load} notice={notice} onRegister={() => setOnboarding({ kind: 'register', organisation: null })} />;
  if (screen.name === 'exam')
    return (
      <BrandContext.Provider value={brand}>
        <ExamView entitlement={screen.entitlement} onExit={load} />
      </BrandContext.Provider>
    );

  return (
    <div className="page">
      <header className="topbar">
        <BrandMark brand={brand} />
        <span className="topbar-actions">
          <button className="link" onClick={() => setScreen({ name: 'help' })}>
            Help
          </button>
          <button
            className="link"
            onClick={async () => {
              await signOut();
              setScreen({ name: 'login' });
            }}
          >
            Sign out
          </button>
        </span>
      </header>
      <main className="content">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {screen.name === 'help' ? (
          <Help items={items} {...(screen.preset ? { preset: screen.preset } : {})} onBack={load} />
        ) : screen.name === 'check' ? (
          <DeviceCheck
            entitlement={screen.entitlement}
            bridge={currentBridge()}
            onDone={load}
            onSupport={() => setScreen({ name: 'help', preset: { category: 'device_check', entitlementId: screen.entitlement.id } })}
          />
        ) : (
          <>
            <Entitlements
              items={items}
              onCheck={(entitlement) => setScreen({ name: 'check', entitlement })}
              onOpen={(entitlement) => setScreen({ name: 'exam', entitlement })}
            />
            <Results items={results} />
          </>
        )}
      </main>
    </div>
  );
}
