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
              <div className="exam-actions">
                <span className={`status ${ready ? 'ok' : e.lastCheckPassed === false ? 'bad' : 'pending'}`}>
                  {ready ? '✓ Device check passed' : e.lastCheckPassed === false ? '✕ Device check failed' : '○ Device check needed'}
                </span>
                <button onClick={() => onCheck(e)}>{ready ? 'Run check again' : 'Run device check'}</button>
                <button className="primary" disabled={!ready} onClick={() => onOpen(e)}>
                  Open exam
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
