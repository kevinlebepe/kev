import { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api';
import { getDesktop } from '../lib/desktop';
import { rulesFrom } from '../lib/examRules';
import { enterFullscreen, exitFullscreen } from '../lib/fullscreen';
import { idbKV, SecureStore } from '../lib/secureStore';
import type { AttemptView, Entitlement, ExamPackage, PendingEvent } from '../lib/types';
import { verifyPackage } from '../lib/verify';
import { ExamSession, type LocalState } from './ExamSession';
import { ReceiptScreen } from './ReceiptScreen';
import { RulesScreen } from './RulesScreen';

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'rules'; pkg: ExamPackage }
  | { phase: 'ready'; pkg: ExamPackage; attempt: AttemptView; local: LocalState | null; localEvents: PendingEvent[] | null };

// One store per browser profile; the key inside it is created on first use.
const store = new SecureStore(idbKV());

// Downloads and verifies the signed package, shows the rules, and only when
// the candidate presses start does it enter full screen and start (or resume)
// the attempt (spec sections 6, 9 and 19).
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
        if (cancelled) return;
        if (!verification.ok) {
          // Never show content from a package that fails integrity checks.
          setState({ phase: 'error', message: 'The downloaded exam failed its integrity check. Do not continue; contact exam support.' });
          return;
        }
        setState({ phase: 'rules', pkg });
      } catch (err) {
        if (!cancelled) setState({ phase: 'error', message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entitlement.id]);

  const leave = useCallback(() => {
    void getDesktop()?.exitExamMode();
    void exitFullscreen();
    onExit();
  }, [onExit]);

  const begin = useCallback(
    async (pkg: ExamPackage): Promise<string | null> => {
      // This runs from the click, which is what lets the browser allow full screen.
      const rules = rulesFrom(pkg.exam.manifest);
      const desktop = getDesktop();
      if (desktop) {
        // The desktop application locks the whole window: kiosk, on top, capture blocked.
        await desktop.enterExamMode();
      } else if (rules.fullscreen && !(await enterFullscreen())) {
        return 'Full screen is required for this exam and was blocked. Allow full screen for this site and try again.';
      }
      try {
        const attempt = await request<AttemptView>('POST', '/attempts/start', { assignmentId: entitlement.id });
        const active = attempt.status === 'active';
        const local = active ? await store.load<LocalState>(attempt.id) : null;
        const localEvents = active ? await store.load<PendingEvent[]>(`${attempt.id}:events`) : null;
        setState({ phase: 'ready', pkg, attempt, local, localEvents });
        return null;
      } catch (err) {
        await desktop?.exitExamMode();
        await exitFullscreen();
        return (err as Error).message;
      }
    },
    [entitlement.id],
  );

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
  if (state.phase === 'rules') {
    return (
      <RulesScreen
        manifest={state.pkg.exam.manifest}
        resuming={entitlement.status === 'active'}
        onStart={() => begin(state.pkg)}
        onBack={onExit}
      />
    );
  }

  const { manifest } = state.pkg.exam;
  if (state.attempt.status !== 'active' && state.attempt.receipt) {
    return <ReceiptScreen examName={manifest.name} receipt={state.attempt.receipt} onExit={leave} />;
  }
  return (
    <ExamSession
      key={state.attempt.id}
      manifest={manifest}
      attempt={state.attempt}
      local={state.local}
      localEvents={state.localEvents}
      store={store}
      onExit={leave}
    />
  );
}
