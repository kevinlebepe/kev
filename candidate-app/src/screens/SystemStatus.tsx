import { useEffect, useState } from 'react';
import { request } from '../lib/api';

interface Status {
  status: 'ok' | 'degraded' | 'down';
  text: string;
  components: { name: string; label: string; status: 'ok' | 'degraded' | 'down'; text: string; since: string }[];
  checkedAt: string;
}

const MARK = { ok: '✓', degraded: '!', down: '✕' } as const;

/**
 * Public status page (spec sections 3 and 21): whether the service is working,
 * so a candidate can tell a problem on their side from one on ours. It needs
 * no sign in and refreshes every 30 seconds.
 */
export function SystemStatus({ onDone }: { onDone: () => void }) {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      request<Status>('GET', '/status')
        .then((d) => {
          if (!stop) {
            setData(d);
            setError(null);
          }
        })
        .catch(() => !stop && setError('The status could not be loaded. If this page does not load either, the service or your connection is down.'));
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  return (
    <main className="centered">
      <section className="card narrow" aria-labelledby="status-title">
        <p className="brand">ExamGuard</p>
        <h1 id="status-title">System status</h1>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {data && (
          <>
            <p className={`status-summary ${data.status}`} role="status">
              {MARK[data.status]} {data.text}
            </p>
            <ul className="status-list">
              {data.components.map((c) => (
                <li key={c.name} className={c.status}>
                  <span>{c.label}</span>
                  <strong>
                    {MARK[c.status]} {c.text}
                  </strong>
                </li>
              ))}
            </ul>
            <p className="help">Checked {new Date(data.checkedAt).toLocaleTimeString()}. This page refreshes by itself.</p>
          </>
        )}
        <p className="help">
          If everything here is working but you cannot sign in or start your exam, contact your organisation’s exam support. Your answers are saved on your device when
          the connection drops.
        </p>
        <button type="button" className="link" onClick={onDone}>
          Back to sign in
        </button>
      </section>
    </main>
  );
}
