import { useCallback, useEffect, useState } from 'react';
import { request, resumeSession, signOut } from './lib/api';
import type { Entitlement } from './lib/types';
import { currentBridge } from './device/bridge';
import { Login } from './screens/Login';
import { Entitlements } from './screens/Entitlements';
import { DeviceCheck } from './screens/DeviceCheck';
import { ExamView } from './screens/ExamView';

type Screen =
  | { name: 'starting' }
  | { name: 'login' }
  | { name: 'home' }
  | { name: 'check'; entitlement: Entitlement }
  | { name: 'exam'; entitlement: Entitlement };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'starting' });
  const [items, setItems] = useState<Entitlement[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await request<{ items: Entitlement[] }>('GET', '/me/entitlements');
      setItems(data.items);
      setError(null);
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
          <Entitlements
            items={items}
            onCheck={(entitlement) => setScreen({ name: 'check', entitlement })}
            onOpen={(entitlement) => setScreen({ name: 'exam', entitlement })}
          />
        )}
      </main>
    </div>
  );
}
