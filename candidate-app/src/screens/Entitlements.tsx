import { getDesktop } from '../lib/desktop';
import { browserIsEnough, detectDevice } from '../lib/deviceType';
import { DOWNLOAD_URL, launchLink } from '../lib/launch';
import type { Entitlement } from '../lib/types';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });

function monitoring(e: Entitlement): string[] {
  const s = e.requirements.security;
  return [s.camera && 'Camera', s.microphone && 'Microphone', s.screenCapture && 'Screen recording', s.kiosk && 'Secure mode'].filter(
    Boolean,
  ) as string[];
}

export function Entitlements({
  items,
  onCheck,
  onOpen,
}: {
  items: Entitlement[];
  onCheck: (e: Entitlement) => void;
  onOpen: (e: Entitlement) => void;
}) {
  if (items.length === 0) {
    return (
      <section className="card">
        <h1>My exams</h1>
        <p>You have no exams assigned yet. Your organisation will notify you when one is assigned.</p>
      </section>
    );
  }

  return (
    <section>
      <h1>My exams</h1>
      <ul className="list">
        {items.map((e) => {
          const ready = e.status === 'precheck_complete';
          const inProgress = e.status === 'active';
          const submitted = e.status === 'submitted' || e.status === 'completed';
          // On a laptop or desktop computer this exam only runs in the desktop application.
          // Phones, tablets and Chromebooks cannot run it, so they carry on in the browser.
          const needsApp =
            e.requirements.device.requireDesktopApp === true && !getDesktop() && !browserIsEnough(detectDevice(navigator).kind) && !submitted;
          return (
            <li key={e.id} className="card exam">
              <div>
                <h2>{e.examName}</h2>
                <p className="muted">
                  {e.examCode} · {e.sessionName}
                </p>
                <p>
                  <time dateTime={e.startsAt}>{dateFormat.format(new Date(e.startsAt))}</time>
                  {e.requirements.timing.durationMinutes ? ` · ${e.requirements.timing.durationMinutes} minutes` : ''}
                </p>
                {monitoring(e).length > 0 && (
                  <p className="muted">This exam uses: {monitoring(e).join(', ')}</p>
                )}
              </div>
              {needsApp ? (
                <div className="app-required" role="note">
                  <p>
                    <strong>This exam must be taken in the ExamGuard desktop app.</strong>
                  </p>
                  <p className="muted small">A browser cannot lock your computer down for this exam.</p>
                  <a className="button primary" href={launchLink(e.id)}>
                    Open in the ExamGuard app
                  </a>
                  {DOWNLOAD_URL ? (
                    <a className="button" href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
                      Download the app
                    </a>
                  ) : (
                    <p className="muted small">Ask your organisation where to download the app.</p>
                  )}
                  <p className="muted small">Sign in again in the app, then run the device check well before the exam.</p>
                </div>
              ) : (
                <div className="exam-actions">
                  <span className={`status ${submitted || ready || inProgress ? 'ok' : e.lastCheckPassed === false ? 'bad' : 'pending'}`}>
                    {submitted
                      ? '✓ Submitted'
                      : inProgress
                        ? '● In progress'
                        : ready
                          ? '✓ Device check passed'
                          : e.lastCheckPassed === false
                            ? '✕ Device check failed'
                            : '○ Device check needed'}
                  </span>
                  {!submitted && !inProgress && <button onClick={() => onCheck(e)}>{ready ? 'Run check again' : 'Run device check'}</button>}
                  <button className="primary" disabled={!ready && !inProgress} hidden={submitted} onClick={() => onOpen(e)}>
                    {inProgress ? 'Continue exam' : 'Open exam'}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
