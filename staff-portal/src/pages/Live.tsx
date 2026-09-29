import { useEffect, useState } from 'react';
import { ActionButton, Badge, ErrorText, Field, Loading, Page, Stat } from '../components/ui';
import { request } from '../lib/api';
import { formatDateTime, formatDuration, formatTime, label } from '../lib/format';
import { href } from '../lib/router';
import { useApi } from '../lib/useApi';

const REFRESH_MS = 5000;

interface LiveSessionRow {
  id: string;
  name: string;
  status: string;
  startsAt: string;
  endsAt: string;
  examName: string;
  candidates: number;
  assigned: number;
}

export function LiveSessions() {
  const list = useApi<{ scope: string; items: LiveSessionRow[] }>('/live/sessions', 30_000);
  return (
    <Page title="Live console">
      <p className="muted">
        {list.data?.scope === 'invigilator'
          ? 'Sessions you are rostered on. You see only the candidates allocated to you.'
          : 'You supervise every candidate in a session. Invigilators see only the candidates allocated to them.'}
      </p>
      <ErrorText error={list.error} />
      <Loading loading={list.loading} empty={list.data?.items.length === 0 && 'No scheduled or open sessions.'}>
        <ul className="cards">
          {list.data?.items.map((s) => (
            <li key={s.id} className="card">
              <h2>
                <a href={href('live', s.id)}>{s.name}</a>
              </h2>
              <p className="muted small">
                {s.examName} · {formatDateTime(s.startsAt)} to {formatTime(s.endsAt)}
              </p>
              <p>
                <Badge value={s.status} /> {list.data?.scope === 'invigilator' ? `${s.assigned} allocated to you` : `${s.candidates} candidates`}
              </p>
            </li>
          ))}
        </ul>
      </Loading>
    </Page>
  );
}

interface LiveCandidate {
  candidateId: string;
  fullName: string;
  studentId: string | null;
  entitlementStatus: string;
  invigilatorName: string | null;
  attemptId: string | null;
  attemptStatus: string | null;
  startedAt: string | null;
  deadlineAt: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  lastSeenAt: string | null;
  online: boolean;
  violations: number;
  lastEvent: { type: string; severity: string; occurredAt: string } | null;
  platform: string | null;
}

interface LiveView {
  session: { id: string; name: string; status: string; startsAt: string; endsAt: string; examName: string };
  scope: 'invigilator' | 'supervisor';
  status: string | null;
  load: { active: number; capacity: number } | null;
  serverTime: string;
  candidates: LiveCandidate[];
}

/** What a candidate is doing right now, in a word for the card. */
export function presence(c: LiveCandidate): { text: string; tone: string } {
  if (c.attemptStatus && c.attemptStatus !== 'active') return { text: c.submittedBy === 'system' ? 'Ended early' : 'Submitted', tone: c.submittedBy === 'system' ? 'bad' : 'info' };
  if (c.attemptStatus === 'active') return c.online ? { text: 'Writing', tone: 'ok' } : { text: 'Not responding', tone: 'bad' };
  if (c.entitlementStatus === 'precheck_complete') return { text: 'Ready to start', tone: 'warn' };
  return { text: 'Not started', tone: 'muted' };
}

export function LiveConsole({ sessionId }: { sessionId: string }) {
  const view = useApi<LiveView>(`/live/sessions/${sessionId}`, REFRESH_MS);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const v = view.data;
  // Local clock correction, so the time left matches the server's deadline.
  const offset = v ? Date.parse(v.serverTime) - Date.now() : 0;
  const candidates = v?.candidates ?? [];
  const writing = candidates.filter((c) => c.attemptStatus === 'active');

  return (
    <Page
      title={v ? `Live: ${v.session.name}` : 'Live console'}
      back={{ href: href('live'), text: 'All sessions' }}
      actions={<span className="muted small">Updates every {REFRESH_MS / 1000} seconds</span>}
    >
      <ErrorText error={view.error} />
      <Loading loading={view.loading}>
        {v && (
          <>
            <p className="muted">
              {v.session.examName} · <Badge value={v.session.status} /> · {v.scope === 'invigilator' ? 'Your allocated candidates' : 'Every candidate in the session'}
              {v.load && ` · ${v.load.active} of ${v.load.capacity} places used`}
            </p>
            <div className="stats">
              <Stat label="writing" value={writing.filter((c) => c.online).length} tone="ok" />
              <Stat label="not responding" value={writing.filter((c) => !c.online).length} tone={writing.some((c) => !c.online) ? 'bad' : ''} />
              <Stat label="with rule breaks" value={candidates.filter((c) => c.violations > 0).length} tone={candidates.some((c) => c.violations) ? 'warn' : ''} />
              <Stat label="submitted" value={candidates.filter((c) => c.attemptStatus && c.attemptStatus !== 'active').length} />
            </div>
            {candidates.length === 0 ? (
              <p className="muted">{v.scope === 'invigilator' ? 'No candidates are allocated to you in this session yet.' : 'No candidates are assigned to this session.'}</p>
            ) : (
              <div className={`live ${selected ? 'with-panel' : ''}`}>
                <ul className="tiles" aria-label="Candidates">
                  {candidates.map((c) => {
                    const p = presence(c);
                    const left = c.deadlineAt && c.attemptStatus === 'active' ? Date.parse(c.deadlineAt) - (now + offset) : null;
                    return (
                      <li key={c.candidateId}>
                        <button
                          className={`tile ${p.tone} ${selected === c.attemptId ? 'selected' : ''}`}
                          disabled={!c.attemptId}
                          onClick={() => setSelected(c.attemptId)}
                          aria-label={`${c.fullName}, ${p.text}, ${c.violations} rule breaks`}
                        >
                          <span className="tile-name">{c.fullName}</span>
                          <span className={`badge ${p.tone}`}>{p.text}</span>
                          {left !== null && <span className="tile-time">{formatDuration(left)} left</span>}
                          {c.violations > 0 && <span className="tile-flags">⚠ {c.violations} rule break{c.violations > 1 ? 's' : ''}</span>}
                          {c.lastEvent && (
                            <span className="muted small">
                              {label(c.lastEvent.type)} {formatTime(c.lastEvent.occurredAt)}
                            </span>
                          )}
                          {v.scope === 'supervisor' && <span className="muted small">{c.invigilatorName ? `Invigilator: ${c.invigilatorName}` : 'No invigilator'}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {selected && <AttemptPanel attemptId={selected} offset={offset} now={now} onClose={() => setSelected(null)} onChanged={view.reload} />}
              </div>
            )}
          </>
        )}
      </Loading>
    </Page>
  );
}

interface AttemptDetail {
  id: string;
  status: string;
  startedAt: string;
  deadlineAt: string;
  submittedAt: string | null;
  submittedBy: string | null;
  lastSeenAt: string | null;
  online: boolean;
  fullName: string;
  studentId: string | null;
  email: string;
  answered: number;
  total: number;
  timeline: { type: string; severity: string; occurredAt: string; data: Record<string, unknown> }[];
  messages: { id: string; kind: string; body: string; createdAt: string; deliveredAt: string | null; sender: string | null }[];
}

function AttemptPanel({ attemptId, offset, now, onClose, onChanged }: { attemptId: string; offset: number; now: number; onClose: () => void; onChanged: () => void }) {
  const detail = useApi<AttemptDetail>(`/live/attempts/${attemptId}`, REFRESH_MS);
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<'message' | 'warning'>('message');
  const [minutes, setMinutes] = useState(10);
  const [note, setNote] = useState('');
  const d = detail.data;
  const active = d?.status === 'active';
  const refresh = async () => {
    await detail.reload();
    onChanged();
  };

  return (
    <aside className="card panel" aria-labelledby="panel-title">
      <div className="row spread">
        <h2 id="panel-title">{d?.fullName ?? 'Candidate'}</h2>
        <button className="small" onClick={onClose} aria-label="Close the candidate panel">
          ✕
        </button>
      </div>
      <ErrorText error={detail.error} />
      {d && (
        <>
          <p className="muted small">
            {d.email}
            {d.studentId && ` · ${d.studentId}`}
          </p>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <Badge value={d.status} /> {active && (d.online ? <Badge value="online" tone="ok" /> : <Badge value="offline" />)}
            </dd>
            <dt>Answered</dt>
            <dd>
              {d.answered} of {d.total}
            </dd>
            {active ? (
              <>
                <dt>Time left</dt>
                <dd>{formatDuration(Date.parse(d.deadlineAt) - (now + offset))}</dd>
              </>
            ) : (
              <>
                <dt>Submitted</dt>
                <dd>
                  {formatTime(d.submittedAt)} ({label(d.submittedBy)})
                </dd>
              </>
            )}
            <dt>Last seen</dt>
            <dd>{d.lastSeenAt ? formatTime(d.lastSeenAt) : 'Not yet'}</dd>
          </dl>

          {active && (
            <>
              <h3>Send to the candidate</h3>
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                }}
              >
                <div className="row">
                  <label className="check">
                    <input type="radio" name="kind" checked={kind === 'message'} onChange={() => setKind('message')} /> Message
                  </label>
                  <label className="check">
                    <input type="radio" name="kind" checked={kind === 'warning'} onChange={() => setKind('warning')} /> Warning
                  </label>
                </div>
                <textarea rows={2} value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} aria-label="Message text" placeholder="For example: please keep your face in view of the camera." />
                <ActionButton
                  className="primary"
                  disabled={!message.trim()}
                  onClick={async () => {
                    await request('POST', `/live/attempts/${attemptId}/messages`, { kind, body: message.trim() });
                    setMessage('');
                    await refresh();
                  }}
                >
                  Send {kind}
                </ActionButton>
              </form>

              <h3>Extra time</h3>
              <div className="row">
                <Field label="Minutes">
                  <input type="number" min={1} max={120} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
                </Field>
                <ActionButton
                  onClick={async () => {
                    const reason = window.prompt(`Why give ${minutes} extra minutes? This is kept in the record.`);
                    if (!reason?.trim()) return;
                    await request('POST', `/live/attempts/${attemptId}/extend`, { minutes, reason: reason.trim() });
                    await refresh();
                  }}
                >
                  Give extra time
                </ActionButton>
              </div>
            </>
          )}

          <h3>Note for the record</h3>
          <textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          <ActionButton
            disabled={!note.trim()}
            onClick={async () => {
              await request('POST', `/live/attempts/${attemptId}/notes`, { note: note.trim() });
              setNote('');
              await refresh();
            }}
          >
            Add note
          </ActionButton>

          {active && (
            <p>
              <ActionButton
                className="danger"
                onClick={async () => {
                  const reason = window.prompt('Why are you ending this exam? The candidate’s saved answers are submitted and the reason is recorded.');
                  if (!reason?.trim()) return;
                  await request('POST', `/live/attempts/${attemptId}/end`, { reason: reason.trim() });
                  await refresh();
                }}
              >
                End this exam now
              </ActionButton>
            </p>
          )}

          {d.messages.length > 0 && (
            <>
              <h3>Messages sent</h3>
              <ul className="plain small">
                {d.messages.map((m) => (
                  <li key={m.id}>
                    <strong>{m.kind === 'warning' ? '⚠ ' : ''}</strong>
                    {m.body} <span className="muted">{formatTime(m.createdAt)} {m.deliveredAt ? '· seen' : '· not yet delivered'}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>Timeline</h3>
          <ol className="timeline small">
            {[...d.timeline].reverse().map((e, i) => (
              <li key={i} className={e.severity}>
                <span className="muted">{formatTime(e.occurredAt)}</span> {label(e.type)}
                {typeof e.data.reason === 'string' && `: ${e.data.reason}`}
                {typeof e.data.note === 'string' && `: ${e.data.note}`}
                {typeof e.data.minutes === 'number' && ` (${e.data.minutes} min)`}
              </li>
            ))}
          </ol>
        </>
      )}
    </aside>
  );
}
