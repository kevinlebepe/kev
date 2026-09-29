import { useCallback, useEffect, useRef, useState } from 'react';
import { request, resumeSession, signOut } from './lib/api';
import { examFromSearch } from './lib/launch';
import type { Entitlement } from './lib/types';
import { currentBridge } from './device/bridge';
import { Login } from './screens/Login';
import { Entitlements } from './screens/Entitlements';
import { DeviceCheck } from './screens/DeviceCheck';
import { ExamView } from './screens/ExamView';
import { type ReleasedResult, Results } from './screens/Results';

type Screen =
  | { name: 'starting' }
  | { name: 'login' }
  | { name: 'home' }
  | { name: 'check'; entitlement: Entitlement }
  | { name: 'exam'; entitlement: Entitlement };

export function App() {
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

  useEffect(() => {
    resumeSession().then((ok) => (ok ? load() : setScreen({ name: 'login' })));
  }, [load]);

  if (screen.name === 'starting') return <main className="centered">Starting…</main>;
  if (screen.name === 'login') return <Login onSignedIn={load} />;
  if (screen.name === 'exam') return <ExamView entitlement={screen.entitlement} onExit={load} />;

  return (
    <div className="page">
      <header className="topbar">
        <span className="brand">EXAMGUARD</span>
        <button
          className="link"
          onClick={async () => {
            await signOut();
            setScreen({ name: 'login' });
          }}
        >
          Sign out
        </button>
      </header>
      <main className="content">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {screen.name === 'check' ? (
          <DeviceCheck entitlement={screen.entitlement} bridge={currentBridge()} onDone={load} />
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
