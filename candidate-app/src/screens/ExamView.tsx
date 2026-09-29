import { useEffect, useState } from 'react';
import { request } from '../lib/api';
import type { Entitlement, ExamPackage } from '../lib/types';
import { type PackageVerification, verifyPackage } from '../lib/verify';

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; pkg: ExamPackage; verification: PackageVerification };

function formatDuration(minutes?: number) {
  if (!minutes) return '--:--:--';
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
}

// Downloads and verifies the signed package, then shows the exam in the
// secure layout (spec section 9). Answering and the running timer arrive
// with attempts in MVP 3; until then the questions are shown read only.
export function ExamView({ entitlement, onExit }: { entitlement: Entitlement; onExit: () => void }) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pkg, key] = await Promise.all([
          request<ExamPackage>('GET', `/me/entitlements/${entitlement.id}/package`),
          request<{ publicKeyPem: string }>('GET', '/exam-signing-key'),
        ]);
        const verification = await verifyPackage(key.publicKeyPem, pkg);
        if (!cancelled) setState({ phase: 'ready', pkg, verification });
      } catch (err) {
        if (!cancelled) setState({ phase: 'error', message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entitlement.id]);

  if (state.phase === 'loading') {
    return <section className="card" aria-busy="true">Downloading and verifying your exam…</section>;
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
  if (!state.verification.ok) {
    // Never show content from a package that fails integrity checks.
    return (
      <section className="card">
        <h1>Exam package could not be verified</h1>
        <p className="error" role="alert">
          The downloaded exam failed its integrity check. Do not continue; contact exam support.
        </p>
        <button onClick={onExit}>Back to my exams</button>
      </section>
    );
  }

  const { manifest } = state.pkg.exam;
  const question = manifest.questions[index]!;
  const total = manifest.questions.length;
  const security = manifest.config.security;
  const indicators = [
    security.screenCapture && 'RECORDING',
    security.camera && 'CAMERA',
    security.microphone && 'MICROPHONE',
    security.kiosk && 'SECURE MODE',
  ].filter(Boolean) as string[];

  return (
    <div className="exam-shell">
      <header className="exam-bar">
        <span className="brand">EXAMGUARD</span>
        <span>{manifest.name}</span>
        <span className="timer" aria-label="Time remaining">
          REMAINING <strong>{formatDuration(manifest.config.timing.durationMinutes)}</strong>
        </span>
      </header>

      <main className="question card">
        <p className="muted">
          QUESTION {index + 1} OF {total} · {question.points} {question.points === 1 ? 'mark' : 'marks'}
        </p>
        <h1 className="prompt">{question.prompt}</h1>
        {question.options.length > 0 ? (
          <fieldset className="options">
            <legend className="sr-only">Options</legend>
            {question.options.map((o) => (
              <label key={o.id} className={`option ${selected[question.id] === o.id ? 'chosen' : ''}`}>
                <input
                  type="radio"
                  name={question.id}
                  checked={selected[question.id] === o.id}
                  onChange={() => setSelected((s) => ({ ...s, [question.id]: o.id }))}
                />
                {o.label}
              </label>
            ))}
          </fieldset>
        ) : (
          <textarea className="answer" rows={8} placeholder="Type your answer" aria-label="Your answer" />
        )}
        <p className="muted small">Preview: answers are not saved until exam attempts are enabled.</p>

        <div className="row spread">
          <button disabled={index === 0 || !manifest.config.navigation.allowBacktrack} onClick={() => setIndex(index - 1)}>
            ‹ Previous
          </button>
          {index < total - 1 ? (
            <button className="primary" onClick={() => setIndex(index + 1)}>
              Save and next ›
            </button>
          ) : (
            <button className="primary" onClick={onExit}>
              Finish preview
            </button>
          )}
        </div>
      </main>

      <footer className="exam-status" aria-label="Security status">
        {indicators.map((i) => (
          <span key={i}>● {i}</span>
        ))}
        <span>✓ PACKAGE VERIFIED (v{manifest.version})</span>
      </footer>
    </div>
  );
}
