import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../lib/api';
import { createServerClock, formatDuration, timeWarning } from '../lib/clock';
import { getDesktop } from '../lib/desktop';
import { EventReporter } from '../lib/eventReporter';
import { noticeText, rulesFrom } from '../lib/examRules';
import { enterFullscreen, exitFullscreen } from '../lib/fullscreen';
import { attachExamRules } from '../lib/rules';
import { type QueuedAnswer, SaveQueue, type SaveStatus } from '../lib/saveQueue';
import type { SecureStore } from '../lib/secureStore';
import type { AnswerResponse, AttemptView, ExamManifest, PendingEvent, Receipt, RulesReply } from '../lib/types';
import { isAnswered, QuestionInput } from './QuestionInput';
import { ReceiptScreen } from './ReceiptScreen';

export interface LocalState {
  pending: QueuedAnswer[];
}

interface Props {
  manifest: ExamManifest;
  attempt: AttemptView;
  /** Unsent answers found on this device from an earlier run of the same attempt. */
  local: LocalState | null;
  /** Rule events found on this device that the server has not acknowledged. */
  localEvents: PendingEvent[] | null;
  store: SecureStore;
  onExit: () => void;
}

type Phase = 'answering' | 'confirming' | 'submitting' | 'done';

const SAVE_TEXT: Record<SaveStatus, string> = {
  saved: '✓ All answers saved',
  saving: '↻ Saving…',
  offline: '⚠ Not saved yet. Answers are kept on this device and will send when the connection returns.',
  closed: '✕ This exam is closed',
};

/** The server closes an attempt with 409 and includes the receipt. */
function receiptFrom(err: unknown): Receipt | null {
  if (err instanceof ApiError && err.status === 409) {
    const details = err.details as { receipt?: Receipt } | undefined;
    return details?.receipt ?? null;
  }
  return null;
}

export function ExamSession({ manifest, attempt, local, localEvents, store, onExit }: Props) {
  const questions = manifest.questions;
  const total = questions.length;
  const deadline = Date.parse(attempt.deadlineAt);
  const allowBacktrack = manifest.config.navigation.allowBacktrack;
  const rules = rulesFrom(manifest);
  // In the desktop application the whole window is locked, so the browser's
  // full screen mode is not used and the window starts out in the right state.
  const desktop = getDesktop();

  const [clock] = useState(() => createServerClock(attempt.serverTime));
  const [answers, setAnswers] = useState<Record<string, AnswerResponse>>(() => {
    const merged: Record<string, AnswerResponse> = {};
    for (const a of attempt.answers) merged[a.questionId] = a.response;
    for (const p of unsentFrom(attempt, local)) merged[p.questionId] = p.response;
    return merged;
  });
  const [index, setIndex] = useState(Math.min(Math.max(attempt.position, 0), total - 1));
  const [remaining, setRemaining] = useState(() => deadline - clock.now());
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [phase, setPhase] = useState<Phase>('answering');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(() => !rules.fullscreen || desktop !== null || Boolean(document.fullscreenElement));
  const [notice, setNotice] = useState<string | null>(null);
  const [returnFailed, setReturnFailed] = useState(false);

  const queueRef = useRef<SaveQueue | null>(null);
  const phaseRef = useRef<Phase>('answering');
  const submittingRef = useRef(false);
  const positionRef = useRef(index);
  const reporterRef = useRef<EventReporter | null>(null);
  // Stops watching the rules. Called the moment the exam ends, so the candidate
  // is not stopped from closing the window on the receipt screen.
  const stopWatchingRef = useRef<() => void>(() => {});
  // Set to false the moment the exam ends, so leaving full screen afterwards is not reported.
  const rulesActiveRef = useRef(true);

  const changePhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const finish = useCallback(
    (r: Receipt) => {
      rulesActiveRef.current = false;
      stopWatchingRef.current();
      queueRef.current?.dispose();
      reporterRef.current?.dispose();
      void store.remove(attempt.id);
      void store.remove(`${attempt.id}:events`);
      void desktop?.exitExamMode();
      void exitFullscreen();
      setReceipt(r);
      changePhase('done');
    },
    [attempt.id, changePhase, desktop, store],
  );

  // The save queue lives for as long as the exam is on screen.
  useEffect(() => {
    const unsent = unsentFrom(attempt, local);
    const queue = new SaveQueue({
      startSeq: attempt.answers.reduce((max, a) => Math.max(max, a.seq), 0),
      initial: unsent,
      send: async (batch, position) => {
        const res = await request<{ acked: { questionId: string; seq: number }[]; serverTime: string }>(
          'PATCH',
          `/attempts/${attempt.id}/state`,
          { answers: batch, ...(position !== undefined ? { position } : {}) },
        );
        clock.sync(res.serverTime);
        return res.acked;
      },
      persist: (pending) => void store.save(attempt.id, { pending } satisfies LocalState),
      onStatus: setSaveStatus,
      // 409: the server has already closed this attempt. 404: it is not ours.
      isFatal: (err) => err instanceof ApiError && (err.status === 409 || err.status === 404),
      onFatal: (err) => {
        const closed = receiptFrom(err);
        if (closed) finish(closed);
        else setError('This exam could not be found. Contact your invigilator.');
      },
    });
    queueRef.current = queue;
    queue.resume();
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, [attempt, clock, finish, local, store]);

  // Watches the exam rules and reports every break to the server, which decides the outcome.
  useEffect(() => {
    const reporter = new EventReporter({
      initial: localEvents ?? [],
      send: (events, keepalive) => request<RulesReply>('POST', `/attempts/${attempt.id}/events`, { events }, { keepalive }),
      persist: (events) => void store.save(`${attempt.id}:events`, events),
      onReply: (reply) => {
        if (reply.action === 'ended' && reply.receipt) finish(reply.receipt);
        else setNotice(noticeText(reply));
      },
      isFatal: (err) => err instanceof ApiError && (err.status === 409 || err.status === 404),
      onFatal: (err) => {
        const closed = receiptFrom(err);
        if (closed) finish(closed);
      },
    });
    reporterRef.current = reporter;
    reporter.resume();
    const detach = attachExamRules(
      window,
      { fullscreen: rules.fullscreen && !desktop, blockClipboard: rules.blockClipboard },
      (type, data) => {
        if (rulesActiveRef.current) reporter.report(type, data);
      },
      {
        onFullscreenChange: setIsFullscreen,
        // Send the close attempt now, with a request that can outlive the page.
        onClosing: () => void reporter.flush({ keepalive: true }),
      },
    );

    // What only the desktop application can see, reported the same way.
    const report = (type: Parameters<typeof reporter.report>[0], data?: Parameters<typeof reporter.report>[1]) => {
      if (rulesActiveRef.current) reporter.report(type, data);
    };
    const stopDesktop = [
      desktop?.onFullscreenChange((isFullscreen) => {
        setIsFullscreen(isFullscreen);
        if (rules.fullscreen) report(isFullscreen ? 'returned_fullscreen' : 'left_fullscreen');
      }),
      desktop?.onCloseRequested(() => {
        report('close_attempt', { via: 'window' });
        void reporter.flush({ keepalive: true });
      }),
      desktop?.onShortcutBlocked((key) => report('shortcut_blocked', { key })),
      desktop?.onDisplayAdded((count) => {
        if (!manifest.config.device.allowExternalMonitors) report('display_added', { count });
      }),
    ];
    const stopWatching = () => {
      stopDesktop.forEach((stop) => stop?.());
      detach();
    };
    stopWatchingRef.current = stopWatching;
    return () => {
      stopWatching();
      reporter.dispose();
      reporterRef.current = null;
    };
  }, [attempt.id, desktop, finish, localEvents, manifest.config.device.allowExternalMonitors, rules.blockClipboard, rules.fullscreen, store]);

  const submit = useCallback(
    async (auto: boolean) => {
      if (submittingRef.current || phaseRef.current === 'done') return;
      submittingRef.current = true;
      changePhase('submitting');
      setError(null);
      for (;;) {
        try {
          // The final unsent answers travel with the submission itself, so
          // nothing depends on a separate save arriving first.
          const res = await request<{ receipt: Receipt }>('POST', `/attempts/${attempt.id}/submit`, {
            answers: queueRef.current?.pending() ?? [],
          });
          finish(res.receipt);
          return;
        } catch (err) {
          const closed = receiptFrom(err);
          if (closed) {
            finish(closed);
            return;
          }
          if (!auto) {
            setError('Your answers could not be submitted. Check your connection and try again. Nothing has been lost.');
            submittingRef.current = false;
            changePhase('confirming');
            return;
          }
          // Out of time: keep trying. The server also submits on its own.
          setError('Time is up. Reconnecting to submit your answers…');
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    },
    [attempt.id, changePhase, finish],
  );
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // Countdown, driven by the server clock. Reaching zero submits.
  useEffect(() => {
    const tick = () => {
      const left = deadline - clock.now();
      setRemaining(left);
      if (left <= 0) void submitRef.current(true);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [clock, deadline]);

  // Coming back to the tab (or waking the laptop) re-checks the clock and the attempt.
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== 'visible' || phaseRef.current === 'done') return;
      void queueRef.current?.flush();
      try {
        const view = await request<AttemptView>('GET', `/attempts/${attempt.id}`);
        clock.sync(view.serverTime);
        if (view.status !== 'active' && view.receipt) finish(view.receipt);
      } catch {
        // Offline: the local clock keeps counting.
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [attempt.id, clock, finish]);

  function setAnswer(questionId: string, response: AnswerResponse, delayMs: number) {
    setAnswers((a) => ({ ...a, [questionId]: response }));
    queueRef.current?.enqueue(questionId, response, delayMs);
  }

  async function returnToFullscreen() {
    if (desktop) {
      await desktop.enterExamMode();
      setReturnFailed(false);
      return;
    }
    setReturnFailed(!(await enterFullscreen()));
  }

  function goTo(next: number) {
    if (next < 0 || next >= total) return;
    if (!allowBacktrack && next < positionRef.current) return;
    positionRef.current = next;
    setIndex(next);
    queueRef.current?.setPosition(next);
  }

  if (phase === 'done' && receipt) return <ReceiptScreen examName={manifest.name} receipt={receipt} onExit={onExit} />;

  const question = questions[index]!;
  const answeredCount = questions.filter((q) => isAnswered(answers[q.id])).length;
  const warning = timeWarning(remaining);
  const busy = phase === 'submitting';
  const outOfFullscreen = rules.fullscreen && !isFullscreen;
  const security = manifest.config.security;
  const indicators = [
    security.screenCapture && 'RECORDING',
    security.camera && 'CAMERA',
    security.microphone && 'MICROPHONE',
    security.kiosk && 'SECURE MODE',
  ].filter(Boolean) as string[];

  return (
    <div className={`exam-shell ${rules.blockClipboard ? 'exam-locked' : ''}`}>
      {outOfFullscreen && (
        <div className="overlay" role="alertdialog" aria-modal="true" aria-labelledby="fs-title">
          <div className="card overlay-card">
            <h1 id="fs-title">You left full screen</h1>
            <p>The exam is hidden until you return to full screen. This has been recorded.</p>
            {notice && <p className="banner bad">{notice}</p>}
            <p className="timer-large" aria-label="Time remaining">
              REMAINING <strong>{formatDuration(remaining)}</strong>
            </p>
            {returnFailed && (
              <p className="error" role="alert">
                Full screen was blocked. Allow full screen for this site and try again.
              </p>
            )}
            <button className="primary" autoFocus onClick={() => void returnToFullscreen()}>
              Return to full screen
            </button>
          </div>
        </div>
      )}
      <header className="exam-bar">
        <span className="brand">EXAMGUARD</span>
        <span>{manifest.name}</span>
        <span className={`timer ${warning !== 'none' ? 'urgent' : ''}`} role="timer" aria-label="Time remaining">
          REMAINING <strong>{formatDuration(remaining)}</strong>
        </span>
      </header>

      {warning !== 'none' && remaining > 0 && (
        <p className="banner warn time-warning" role="status">
          ⚠ {warning === 'one_minute' ? 'Less than 1 minute remaining. Your answers will be submitted automatically.' : 'Less than 5 minutes remaining.'}
        </p>
      )}
      {error && (
        <p className="banner bad" role="alert">
          {error}
        </p>
      )}
      {notice && !outOfFullscreen && (
        <p className="banner bad" role="alert">
          ⚠ {notice}
        </p>
      )}

      <div className={`exam-body ${allowBacktrack ? 'with-nav' : ''}`}>
        {allowBacktrack && (
          <nav className="qnav" aria-label="Questions">
            <ol>
              {questions.map((q, i) => (
                <li key={q.id}>
                  <button
                    className={i === index ? 'current' : ''}
                    aria-current={i === index ? 'step' : undefined}
                    aria-label={`Question ${i + 1}, ${isAnswered(answers[q.id]) ? 'answered' : 'not answered'}`}
                    disabled={busy}
                    onClick={() => goTo(i)}
                  >
                    {i + 1} {isAnswered(answers[q.id]) ? '✓' : '○'}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}

        {phase === 'answering' || busy ? (
          <main className="question card">
            <p className="muted">
              QUESTION {index + 1} OF {total} · {question.points} {question.points === 1 ? 'mark' : 'marks'}
            </p>
            <h1 className="prompt">{question.prompt}</h1>
            <div aria-disabled={busy}>
              <QuestionInput question={question} value={answers[question.id]} onChange={(r, d) => !busy && setAnswer(question.id, r, d)} />
            </div>

            <div className="row spread">
              <button disabled={busy || index === 0 || !allowBacktrack} onClick={() => goTo(index - 1)}>
                ‹ Previous
              </button>
              {index < total - 1 ? (
                <button className="primary" disabled={busy} onClick={() => goTo(index + 1)}>
                  Save and next ›
                </button>
              ) : (
                <button className="primary" disabled={busy} onClick={() => changePhase('confirming')}>
                  Review and submit
                </button>
              )}
            </div>
            {busy && <p role="status">Submitting your answers…</p>}
            {!busy && index < total - 1 && (
              <p className="muted small submit-now">
                <button className="link" onClick={() => changePhase('confirming')}>
                  Submit the exam now
                </button>
              </p>
            )}
          </main>
        ) : (
          <main className="question card" aria-labelledby="confirm-title">
            <h1 id="confirm-title">Submit your exam?</h1>
            <p>
              You have answered <strong>{answeredCount}</strong> of <strong>{total}</strong> questions.
              {answeredCount < total && ' Unanswered questions will score no marks.'}
            </p>
            <p>You cannot change your answers after you submit.</p>
            <div className="row">
              <button autoFocus onClick={() => changePhase('answering')}>
                Go back to the exam
              </button>
              <button className="primary" onClick={() => void submit(false)}>
                Submit exam
              </button>
            </div>
          </main>
        )}
      </div>

      <footer className="exam-status" aria-label="Status">
        <span className={`save-status ${saveStatus}`} role="status">
          {SAVE_TEXT[saveStatus]}
        </span>
        {indicators.map((i) => (
          <span key={i}>● {i}</span>
        ))}
        {rules.fullscreen && <span>{isFullscreen ? '✓ FULL SCREEN' : '✕ NOT IN FULL SCREEN'}</span>}
        <span>✓ PACKAGE VERIFIED (v{manifest.version})</span>
      </footer>
    </div>
  );
}

/** Local answers newer than what the server holds; older copies are already saved. */
function unsentFrom(attempt: AttemptView, local: LocalState | null): QueuedAnswer[] {
  const serverSeq = new Map(attempt.answers.map((a) => [a.questionId, a.seq]));
  return (local?.pending ?? []).filter((p) => p.seq > (serverSeq.get(p.questionId) ?? 0));
}
