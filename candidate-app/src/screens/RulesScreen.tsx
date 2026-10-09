import { useState } from 'react';
import { getDesktop } from '../lib/desktop';
import { fullscreenSupported } from '../lib/fullscreen';
import { consequenceText, rulesFrom } from '../lib/examRules';
import { BrandMark, useBrand } from '../lib/brand';
import type { ExamManifest } from '../lib/types';

function joinWithAnd(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// Shown before the timer starts, so the candidate knows the rules and the
// consequences first (spec section 19: clear notice). The click that starts
// the exam is also what lets the browser enter full screen.
export function RulesScreen({
  manifest,
  notice = null,
  resuming,
  onStart,
  onBack,
  screenShare,
}: {
  manifest: ExamManifest;
  /** The organisation's own notice about monitoring and data; the candidate must agree to start. */
  notice?: string | null;
  resuming: boolean;
  /** Set when the exam records the screen and this is a browser: sharing comes first, from its own click. */
  screenShare?: { shared: boolean; supported: boolean; request: () => Promise<string | null> };
  /** Resolves to an error message, or null when the exam has started. */
  onStart: () => Promise<string | null>;
  onBack: () => void;
}) {
  const rules = rulesFrom(manifest);
  const security = manifest.config.security;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const needsAgreement = Boolean(notice) && !resuming;
  // The desktop application locks the whole window itself, so it needs no browser support.
  const cannotFullscreen = rules.fullscreen && !getDesktop() && !fullscreenSupported();
  const duration = manifest.config.timing.durationMinutes;

  const monitored = [security.camera && 'your camera', security.microphone && 'your microphone', security.screenCapture && 'your screen'].filter(
    Boolean,
  ) as string[];

  async function share() {
    if (!screenShare) return;
    setBusy(true);
    setError(null);
    setError(await screenShare.request());
    setBusy(false);
  }
  const needsShare = Boolean(screenShare && !screenShare.shared);

  async function start() {
    setBusy(true);
    setError(null);
    const problem = await onStart();
    if (problem) {
      setError(problem);
      setBusy(false);
    }
  }

  const brand = useBrand();
  return (
    <main className="centered">
      <section className="card rules" aria-labelledby="rules-title">
        <p className="brand-line">
          <BrandMark brand={brand} />
        </p>
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

        {needsAgreement && (
          <section className="notice" aria-labelledby="notice-title">
            <h3 id="notice-title">Notice from your organisation</h3>
            <div className="notice-text" tabIndex={0}>
              {notice}
            </div>
            <label className="check">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I have read this notice and agree to it
            </label>
          </section>
        )}

        {cannotFullscreen && (
          <p className="error" role="alert">
            This device or browser cannot show the exam in full screen. Use the ExamGuard desktop application or another browser.
          </p>
        )}
        {screenShare && !screenShare.supported && (
          <p className="error" role="alert">
            This exam records your screen, and this browser cannot share it. Use a computer with Chrome, Edge or Firefox, or the ExamGuard desktop application.
          </p>
        )}
        {screenShare?.supported && (
          <p className={`banner ${screenShare.shared ? 'ok' : 'warn'}`} role="status">
            {screenShare.shared
              ? '✓ Your screen is being shared for the recording.'
              : 'This exam records your screen. Press Share my screen and choose your entire screen, not a window or a tab.'}
          </p>
        )}
        {screenShare?.shared && (
          <p className="muted small">
            Your browser shows a small bar saying your screen is being shared. Leave it alone: clicking it, or switching to another window, takes you out of the
            exam and is recorded.
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
          {needsShare ? (
            <button className="primary" onClick={share} disabled={busy || !screenShare?.supported}>
              {busy ? 'Waiting…' : 'Share my screen'}
            </button>
          ) : (
            <button className="primary" onClick={start} disabled={busy || cannotFullscreen || (needsAgreement && !agreed)}>
              {busy ? 'Starting…' : `${resuming ? 'Continue' : 'Start'} exam${rules.fullscreen ? ' in full screen' : ''}`}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
