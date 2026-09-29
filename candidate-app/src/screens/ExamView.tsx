import { useEffect, useState } from 'react';
import { request } from '../lib/api';
import { idbKV, SecureStore } from '../lib/secureStore';
import type { AttemptView, Entitlement, ExamPackage } from '../lib/types';
import { verifyPackage } from '../lib/verify';
import { ExamSession, type LocalState } from './ExamSession';
import { ReceiptScreen } from './ReceiptScreen';

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; pkg: ExamPackage; attempt: AttemptView; local: LocalState | null };

// One store per browser profile; the key inside it is created on first use.
const store = new SecureStore(idbKV());

// Downloads and verifies the signed package, starts (or resumes) the attempt,
// and only then shows any exam content (spec sections 6 and 9).
export function ExamView({ entitlement, onExit }: { entitlement: Entitlement; onExit: () => void }) {
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pkg, key] = await Promise.all([
          request<ExamPackage>('GET', `/me/entitlements/${entitlement.id}/package`),
          request<{ publicKeyPem: string }>('GET', '/exam-signing-key'),
        ]);
        const verification = await verifyPackage(key.publicKeyPem, pkg);
        if (!verification.ok) {
          // Never show content from a package that fails integrity checks.
          if (!cancelled) {
            setState({ phase: 'error', message: 'The downloaded exam failed its integrity check. Do not continue; contact exam support.' });
          }
          return;
        }
        const attempt = await request<AttemptView>('POST', '/attempts/start', { assignmentId: entitlement.id });
        const local = attempt.status === 'active' ? await store.load<LocalState>(attempt.id) : null;
        if (!cancelled) setState({ phase: 'ready', pkg, attempt, local });
      } catch (err) {
        if (!cancelled) setState({ phase: 'error', message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entitlement.id]);

  if (state.phase === 'loading') {
    return (
      <section className="card" aria-busy="true">
        Downloading and verifying your exam…
      </section>
    );
  }
  if (state.phase === 'error') {
    return (
      <section className="card">
        <h1>Exam not available</h1>
        <p className="error" role="alert">
          {state.message}
        </p>
        <button onClick={onExit}>Back to my exams</button>
      </section>
    );
  }

  const { manifest } = state.pkg.exam;
  if (state.attempt.status !== 'active' && state.attempt.receipt) {
    return <ReceiptScreen examName={manifest.name} receipt={state.attempt.receipt} onExit={onExit} />;
  }
  return <ExamSession key={state.attempt.id} manifest={manifest} attempt={state.attempt} local={state.local} store={store} onExit={onExit} />;
}
