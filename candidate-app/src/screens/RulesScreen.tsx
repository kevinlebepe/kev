import { useState } from 'react';
import { fullscreenSupported } from '../lib/fullscreen';
import { consequenceText, rulesFrom } from '../lib/examRules';
import type { ExamManifest } from '../lib/types';

function joinWithAnd(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// Shown before the timer starts, so the candidate knows the rules and the
// consequences first (spec section 19: clear notice). The click that starts
// the exam is also what lets the browser enter full screen.
export function RulesScreen({
  manifest,
  resuming,
  onStart,
  onBack,
}: {
  manifest: ExamManifest;
  resuming: boolean;
  /** Resolves to an error message, or null when the exam has started. */
  onStart: () => Promise<string | null>;
  onBack: () => void;
}) {
  const rules = rulesFrom(manifest);
  const security = manifest.config.security;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cannotFullscreen = rules.fullscreen && !fullscreenSupported();
  const duration = manifest.config.timing.durationMinutes;

  const monitored = [security.camera && 'your camera', security.microphone && 'your microphone', security.screenCapture && 'your screen'].filter(
    Boolean,
  ) as string[];

  async function start() {
    setBusy(true);
    setError(null);
    const problem = await onStart();
    if (problem) {
      setError(problem);
      setBusy(false);
    }
  }

  return (
    <main className="centered">
      <section className="card rules" aria-labelledby="rules-title">
        <p className="brand">EXAMGUARD</p>
        <h1 id="rules-title">{manifest.name}</h1>
        <h2>{resuming ? 'Before you continue' : 'Before you start'}</h2>

        <ul className="rule-list">
          {rules.fullscreen && <li>The exam runs in <strong>full screen</strong>. You must stay in full screen.</li>}
          <li>
            Do <strong>not switch to another tab or program</strong>, and do not close, reload or leave this window.
          </li>
          {rules.blockClipboard && <li>Copying, cutting, pasting, right click and browser shortcuts are blocked.</li>}
          {monitored.length > 0 && <li>This exam uses {joinWithAnd(monitored)}.</li>}
          {duration && (
            <li>
              You have <strong>{duration} minutes</strong>.{' '}
              {resuming ? 'Your time kept running while you were away.' : 'The timer starts when you press the button below and cannot be paused.'}
            </li>
          )}
          <li>
            Your answers save automatically. If your connection drops, the exam continues and your answers are sent when it returns.
          </li>
        </ul>

        <p className={`banner ${rules.policy === 'flag' ? 'warn' : 'bad'}`} role="note">
          {rules.policy === 'flag' ? '⚠ ' : '⛔ '}
          {consequenceText(rules)}
        </p>

        {cannotFullscreen && (
          <p className="error" role="alert">
            This device or browser cannot show the exam in full screen. Use the ExamGuard desktop application or another browser.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="row">
          <button onClick={onBack} disabled={busy}>
            Back
          </button>
          <button className="primary" onClick={start} disabled={busy || cannotFullscreen}>
            {busy ? 'Starting…' : `${resuming ? 'Continue' : 'Start'} exam${rules.fullscreen ? ' in full screen' : ''}`}
          </button>
        </div>
      </section>
    </main>
  );
}
