import { useState } from 'react';
import { ActionButton, Badge, ErrorText, Loading, Page, Stat } from '../components/ui';
import { download } from '../lib/api';
import { formatDateTime, formatDuration, label } from '../lib/format';
import { href } from '../lib/router';
import { useApi } from '../lib/useApi';

// Reports (spec section 18). Technical events are shown as events: a report
// says what happened and when, and people decide what it means.

type Tab = 'health' | 'incidents' | 'blackouts' | 'recording' | 'invigilation' | 'organisation';
const TABS: { key: Tab; text: string; needsSession: boolean }[] = [
  { key: 'health', text: 'Session health', needsSession: true },
  { key: 'incidents', text: 'Incidents', needsSession: false },
  { key: 'blackouts', text: 'Time offline', needsSession: false },
  { key: 'recording', text: 'Recording health', needsSession: true },
  { key: 'invigilation', text: 'Invigilation', needsSession: true },
  { key: 'organisation', text: 'Organisation', needsSession: false },
];

export const FLAG_TEXT: Record<string, string> = {
  identity: 'Identity',
  another_person: 'Another person present',
  materials: 'Materials not allowed',
  device: 'Another device',
  behaviour: 'Behaviour',
  technical: 'Technical problem',
  other: 'Other',
};

/** A short description of an event's details for a table cell. */
export function eventDetail(type: string, data: Record<string, unknown>): string {
  if (type === 'invigilator_flag') return `${FLAG_TEXT[String(data.reason)] ?? String(data.reason)}${data.note ? `: ${String(data.note)}` : ''}`;
  if (type === 'invigilator_note') return String(data.note ?? '');
  if (typeof data.offlineSeconds === 'number') return `Offline for ${formatDuration(data.offlineSeconds * 1000)}`;
  if (typeof data.minutes === 'number') return `${data.minutes} minutes`;
  return '';
}

export function Reports() {
  const sessions = useApi<{ items: { id: string; name: string; startsAt: string; status: string }[] }>('/sessions?limit=100');
  const [sessionId, setSessionId] = useState('');
  const [tab, setTab] = useState<Tab>('health');
  const current = TABS.find((t) => t.key === tab)!;

  return (
    <Page title="Reports">
      <p className="muted">Reports state what happened and when. A technical event, such as time offline or a recording that stopped, is not a finding against the candidate.</p>
      <div className="row">
        <label className="field">
          <span>Session</span>
          <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            <option value="">All sessions</option>
            {sessions.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({formatDateTime(s.startsAt)})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'tab active' : 'tab'} onClick={() => setTab(t.key)}>
            {t.text}
          </button>
        ))}
      </div>
      {current.needsSession && !sessionId ? (
        <p className="muted">Choose a session for this report.</p>
      ) : (
        <>
          {tab === 'health' && <SessionHealth sessionId={sessionId} />}
          {tab === 'incidents' && <Incidents sessionId={sessionId} />}
          {tab === 'blackouts' && <Blackouts sessionId={sessionId} />}
          {tab === 'recording' && <RecordingHealth sessionId={sessionId} />}
          {tab === 'invigilation' && <Invigilation sessionId={sessionId} />}
          {tab === 'organisation' && <Organisation />}
        </>
      )}
    </Page>
  );
}

const query = (sessionId: string, extra = '') => `?${sessionId ? `sessionId=${sessionId}&` : ''}${extra}`;

function CsvButton({ path, name }: { path: string; name: string }) {
  return <ActionButton onClick={() => download(path, name)}>Download CSV</ActionButton>;
}

function Candidate({ name, studentId, attemptId }: { name: string; studentId: string | null; attemptId: string }) {
  return (
    <a href={href('report', attemptId)}>
      {name}
      {studentId && <span className="muted small"> {studentId}</span>}
    </a>
  );
}

interface Health {
  name: string;
  status: string;
  assigned: number;
  ready: number;
  sitting: number;
  offline: number;
  submitted: number;
  evidencePending: number;
  unwatched: number;
  invigilatorsPresent: number;
  invigilatorsRostered: number;
  recentIncidents: number;
  recentIncidentMinutes: number;
}

function SessionHealth({ sessionId }: { sessionId: string }) {
  const r = useApi<Health>(`/reports/session-health?sessionId=${sessionId}`, 15_000);
  const d = r.data;
  return (
    <section>
      <ErrorText error={r.error} />
      <Loading loading={r.loading}>
        {d && (
          <>
            <p>
              {d.name} · <Badge value={d.status} /> <span className="muted small">Refreshes every 15 seconds.</span>
            </p>
            <div className="stats">
              <Stat label="assigned" value={d.assigned} />
              <Stat label="device check passed, not started" value={d.ready} />
              <Stat label="sitting now" value={d.sitting} tone="ok" />
              <Stat label="sitting but offline" value={d.offline} tone={d.offline ? 'warn' : ''} />
              <Stat label="submitted" value={d.submitted} />
              <Stat label="recordings still arriving" value={d.evidencePending} tone={d.evidencePending ? 'warn' : ''} />
              <Stat label="without an invigilator" value={d.unwatched} tone={d.unwatched ? 'bad' : ''} />
              <Stat label="invigilators present" value={`${d.invigilatorsPresent} of ${d.invigilatorsRostered}`} />
              <Stat label={`serious events, last ${d.recentIncidentMinutes} minutes`} value={d.recentIncidents} tone={d.recentIncidents ? 'bad' : ''} />
            </div>
          </>
        )}
      </Loading>
    </section>
  );
}

interface Incident {
  occurredAt: string;
  type: string;
  severity: string;
  data: Record<string, unknown>;
  attemptId: string;
  candidateName: string;
  studentId: string | null;
  sessionName: string;
  raisedBy: string | null;
}

function Incidents({ sessionId }: { sessionId: string }) {
  const [severity, setSeverity] = useState<'all' | 'high'>('all');
  const r = useApi<{ items: Incident[]; byType: { type: string; severity: string; count: number }[] }>(`/reports/incidents${query(sessionId, 'limit=500')}`);
  const items = (r.data?.items ?? []).filter((i) => severity === 'all' || i.severity === 'high');
  return (
    <section>
      <div className="row spread">
        <label className="field">
          <span>Show</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as 'all' | 'high')}>
            <option value="all">Warnings and serious events</option>
            <option value="high">Serious events only</option>
          </select>
        </label>
        <CsvButton path={`/reports/incidents${query(sessionId, 'format=csv&limit=1000')}`} name="incidents.csv" />
      </div>
      <ErrorText error={r.error} />
      <Loading loading={r.loading} empty={items.length === 0 && 'Nothing to report.'}>
        {r.data && r.data.byType.length > 0 && (
          <p className="small">
            {r.data.byType.map((t) => (
              <span key={t.type + t.severity} className="chip">
                {label(t.type)}: {t.count}
              </span>
            ))}
          </p>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Candidate</th>
                {!sessionId && <th>Session</th>}
                <th>Event</th>
                <th>Details</th>
                <th>Raised by</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i, n) => (
                <tr key={n}>
                  <td className="small">{formatDateTime(i.occurredAt)}</td>
                  <td>
                    <Candidate name={i.candidateName} studentId={i.studentId} attemptId={i.attemptId} />
                  </td>
                  {!sessionId && <td className="small">{i.sessionName}</td>}
                  <td>
                    <Badge value={i.severity === 'high' ? 'serious' : 'warning'} tone={i.severity === 'high' ? 'bad' : 'warn'} /> {label(i.type)}
                  </td>
                  <td className="small">{eventDetail(i.type, i.data)}</td>
                  <td className="small">{i.raisedBy ?? 'System'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Loading>
    </section>
  );
}

interface Blackout {
  attemptId: string;
  candidateName: string;
  studentId: string | null;
  sessionName: string;
  interruptions: number;
  totalSeconds: number;
  longestSeconds: number;
  overLimit: number;
  lastAt: string;
  attemptStatus: string;
  submissionStatus: string | null;
}

function Blackouts({ sessionId }: { sessionId: string }) {
  const r = useApi<{ summary: { candidatesAffected: number; interruptions: number; totalSeconds: number; overLimit: number }; items: Blackout[] }>(
    `/reports/blackouts${query(sessionId, 'limit=1000')}`,
  );
  const s = r.data?.summary;
  return (
    <section>
      <div className="row spread">
        <p className="muted small">Each time a candidate's device came back after at least a minute without a connection. Answers are kept on the device meanwhile.</p>
        <CsvButton path={`/reports/blackouts${query(sessionId, 'format=csv&limit=1000')}`} name="time-offline.csv" />
      </div>
      <ErrorText error={r.error} />
      <Loading loading={r.loading} empty={r.data?.items.length === 0 && 'No candidate lost their connection.'}>
        {s && (
          <div className="stats">
            <Stat label="candidates affected" value={s.candidatesAffected} />
            <Stat label="interruptions" value={s.interruptions} />
            <Stat label="time offline in all" value={formatDuration(s.totalSeconds * 1000)} />
            <Stat label="over the exam's limit" value={s.overLimit} tone={s.overLimit ? 'warn' : ''} />
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                {!sessionId && <th>Session</th>}
                <th>Interruptions</th>
                <th>In all</th>
                <th>Longest</th>
                <th>Over the limit</th>
                <th>Exam</th>
              </tr>
            </thead>
            <tbody>
              {r.data?.items.map((b) => (
                <tr key={b.attemptId}>
                  <td>
                    <Candidate name={b.candidateName} studentId={b.studentId} attemptId={b.attemptId} />
                  </td>
                  {!sessionId && <td className="small">{b.sessionName}</td>}
                  <td>{b.interruptions}</td>
                  <td>{formatDuration(b.totalSeconds * 1000)}</td>
                  <td>{formatDuration(b.longestSeconds * 1000)}</td>
                  <td>{b.overLimit ? <Badge value={`${b.overLimit} time${b.overLimit > 1 ? 's' : ''}`} tone="warn" /> : 'No'}</td>
                  <td>
                    <Badge value={b.submissionStatus ?? b.attemptStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Loading>
    </section>
  );
}

interface RecordingRow {
  attemptId: string;
  candidateName: string;
  studentId: string | null;
  status: string;
  submissionStatus: string | null;
  stopped: number;
  complete: boolean;
  streams: Record<string, { pieces: number; bytes: number; missing: number }>;
}

function RecordingHealth({ sessionId }: { sessionId: string }) {
  const r = useApi<{ expected: string[]; summary: { attempts: number; complete: number; stopped: number }; items: RecordingRow[] }>(
    `/reports/recording-health?sessionId=${sessionId}`,
  );
  const d = r.data;
  return (
    <section>
      <div className="row spread">
        <p className="muted small">Which recording pieces have arrived for each candidate, and whether any are missing.</p>
        <CsvButton path={`/reports/recording-health?sessionId=${sessionId}&format=csv`} name="recording-health.csv" />
      </div>
      <ErrorText error={r.error} />
      <Loading loading={r.loading}>
        {d && d.expected.length === 0 ? (
          <p className="muted">This exam does not record the camera, microphone or screen.</p>
        ) : (
          d && (
            <>
              <div className="stats">
                <Stat label="attempts" value={d.summary.attempts} />
                <Stat label="complete" value={d.summary.complete} tone="ok" />
                <Stat label="a recording stopped" value={d.summary.stopped} tone={d.summary.stopped ? 'warn' : ''} />
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Candidate</th>
                      {d.expected.map((t) => (
                        <th key={t}>{label(t)}</th>
                      ))}
                      <th>Stopped</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((a) => (
                      <tr key={a.attemptId}>
                        <td>
                          <Candidate name={a.candidateName} studentId={a.studentId} attemptId={a.attemptId} />
                        </td>
                        {d.expected.map((t) => (
                          <td key={t} className="small">
                            {a.streams[t]!.pieces} pieces{a.streams[t]!.missing ? <strong>, {a.streams[t]!.missing} missing</strong> : ''}
                          </td>
                        ))}
                        <td>{a.stopped || ''}</td>
                        <td>
                          <Badge value={a.status === 'active' ? 'sitting' : a.complete ? 'complete' : 'incomplete'} tone={a.status === 'active' ? 'info' : a.complete ? 'ok' : 'bad'} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        )}
      </Loading>
    </section>
  );
}

interface InvigilatorRow {
  invigilatorId: string;
  name: string;
  email: string;
  status: string;
  candidates: number;
  watchingNow: number;
  messages: number;
  warnings: number;
  videoCalls: number;
  voiceCalls: number;
  notes: number;
  flags: number;
  extraTime: number;
  ended: number;
  handedOver: number;
  lastSeenAt: string | null;
}

function Invigilation({ sessionId }: { sessionId: string }) {
  const r = useApi<{ unassigned: number; items: InvigilatorRow[] }>(`/reports/invigilation?sessionId=${sessionId}`);
  return (
    <section>
      <div className="row spread">
        <p className="muted small">What each rostered invigilator did in this session.</p>
        <CsvButton path={`/reports/invigilation?sessionId=${sessionId}&format=csv`} name="invigilation.csv" />
      </div>
      <ErrorText error={r.error} />
      <Loading loading={r.loading} empty={r.data?.items.length === 0 && 'No invigilators are rostered for this session.'}>
        {r.data && r.data.unassigned > 0 && <p className="banner warn">{r.data.unassigned} candidates have no invigilator at the moment.</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Invigilator</th>
                <th>Candidates</th>
                <th>Messages</th>
                <th>Warnings</th>
                <th>Video</th>
                <th>Voice</th>
                <th>Notes</th>
                <th>Flags</th>
                <th>Extra time</th>
                <th>Ended</th>
                <th>Handed over</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {r.data?.items.map((i) => (
                <tr key={i.invigilatorId}>
                  <td>
                    {i.name} <Badge value={i.status} />
                  </td>
                  <td>
                    {i.candidates} <span className="muted small">({i.watchingNow} now)</span>
                  </td>
                  <td>{i.messages}</td>
                  <td>{i.warnings}</td>
                  <td>{i.videoCalls}</td>
                  <td>{i.voiceCalls}</td>
                  <td>{i.notes}</td>
                  <td>{i.flags}</td>
                  <td>{i.extraTime}</td>
                  <td>{i.ended}</td>
                  <td>{i.handedOver}</td>
                  <td className="small">{formatDateTime(i.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Loading>
    </section>
  );
}

interface OrgReport {
  sessions: { total: number; open: number; closed: number };
  attempts: { started: number; submitted: number; byTimer: number; bySystem: number; byInvigilator: number; completionPercent: number | null };
  results: { pending: number; marked: number; released: number; averagePercent: number | null };
  candidates: Record<string, number>;
  technicalEvents: { type: string; severity: string; count: number; counted: boolean }[];
}

function Organisation() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = [from && `from=${encodeURIComponent(new Date(from).toISOString())}`, to && `to=${encodeURIComponent(new Date(`${to}T23:59:59`).toISOString())}`]
    .filter(Boolean)
    .join('&');
  const r = useApi<OrgReport>(`/reports/organisation?${params}`);
  const d = r.data;
  return (
    <section>
      <div className="row">
        <label className="field">
          <span>From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <ErrorText error={r.error} />
      <Loading loading={r.loading}>
        {d && (
          <>
            <h3>Sessions and attempts</h3>
            <div className="stats">
              <Stat label="sessions" value={d.sessions.total} />
              <Stat label="attempts started" value={d.attempts.started} />
              <Stat label="submitted" value={d.attempts.submitted} />
              <Stat label="completion" value={d.attempts.completionPercent === null ? '' : `${d.attempts.completionPercent}%`} />
              <Stat label="closed by the timer" value={d.attempts.byTimer} />
              <Stat label="ended for the exam rules or by an invigilator" value={d.attempts.bySystem} />
            </div>
            <h3>Results</h3>
            <div className="stats">
              <Stat label="waiting for a marker" value={d.results.pending} />
              <Stat label="marked, not released" value={d.results.marked} />
              <Stat label="released" value={d.results.released} tone="ok" />
              <Stat label="average released score" value={d.results.averagePercent === null ? '' : `${d.results.averagePercent}%`} />
            </div>
            <h3>Candidates</h3>
            <div className="stats">
              {Object.entries(d.candidates).map(([status, n]) => (
                <Stat key={status} label={label(status).toLowerCase()} value={n} />
              ))}
            </div>
            <h3>Technical and rule events</h3>
            {d.technicalEvents.length === 0 ? (
              <p className="muted">None in this period.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Severity</th>
                      <th>Count</th>
                      <th>Counts towards the exam rules</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.technicalEvents.map((t) => (
                      <tr key={t.type + t.severity}>
                        <td>{label(t.type)}</td>
                        <td>{t.severity === 'high' ? 'Serious' : 'Warning'}</td>
                        <td>{t.count}</td>
                        <td>{t.counted ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Loading>
    </section>
  );
}

interface AttemptReportData {
  attemptId: string;
  status: string;
  startedAt: string;
  deadlineAt: string;
  submittedAt: string | null;
  submittedBy: string | null;
  candidate: { id: string; fullName: string; studentId: string | null; email: string; status: string; identityStatus: string };
  exam: { name: string; code: string; version: number; manifestSha256: string };
  session: { id: string; name: string; startsAt: string; endsAt: string };
  extraMinutes: number;
  submissionStatus: string | null;
  packageSha256: string | null;
  verifiedAt: string | null;
  resultStatus: string | null;
  releasedAt: string | null;
  score: number | null;
  maxScore: number;
  percent: number | null;
  needsManual: number;
  answers: { questionId: string; type: string; prompt: string; answer: { choices?: string[]; text?: string; name?: string } | null; awarded: number | null; maxPoints: number }[];
  evidence: { expected: string[]; complete: boolean } | null;
  offline: { interruptions: number; totalSeconds: number };
  timeline: { type: string; severity: string; occurredAt: string; data: Record<string, unknown>; by: string | null }[];
}

/** One attempt, in full, laid out to print (spec section 18, candidate attempt report). */
export function AttemptReport({ attemptId }: { attemptId: string }) {
  const r = useApi<AttemptReportData>(`/attempts/${attemptId}/report`);
  const d = r.data;
  return (
    <Page
      title={d ? `Attempt report: ${d.candidate.fullName}` : 'Attempt report'}
      back={d ? { href: href('sessions', d.session.id, 'results'), text: 'Results' } : undefined}
      actions={<button onClick={() => window.print()}>Print</button>}
    >
      <ErrorText error={r.error} />
      <Loading loading={r.loading}>
        {d && (
          <div className="report">
            <dl className="facts">
              <dt>Candidate</dt>
              <dd>
                {d.candidate.fullName}
                {d.candidate.studentId && ` (${d.candidate.studentId})`}, {d.candidate.email}
              </dd>
              <dt>Identity</dt>
              <dd>
                {label(d.candidate.identityStatus)}, account {label(d.candidate.status).toLowerCase()}
              </dd>
              <dt>Exam</dt>
              <dd>
                {d.exam.name} ({d.exam.code}), version {d.exam.version}
              </dd>
              <dt>Session</dt>
              <dd>{d.session.name}</dd>
              <dt>Started</dt>
              <dd>{formatDateTime(d.startedAt)}</dd>
              <dt>Submitted</dt>
              <dd>
                {d.submittedAt ? `${formatDateTime(d.submittedAt)}, ${d.submittedBy === 'candidate' ? 'by the candidate' : d.submittedBy === 'timer' ? 'when the time ran out' : 'by the system'}` : 'Still sitting'}
              </dd>
              {d.extraMinutes > 0 && (
                <>
                  <dt>Extra time</dt>
                  <dd>{d.extraMinutes} minutes (accommodation)</dd>
                </>
              )}
              <dt>Score</dt>
              <dd>
                {d.score === null ? 'Not yet submitted' : `${d.score} of ${d.maxScore} (${d.percent}%)`}
                {d.needsManual > 0 && `, ${d.needsManual} answers still to mark`} {d.resultStatus && <Badge value={d.resultStatus} />}
              </dd>
              <dt>Submission</dt>
              <dd>
                {d.submissionStatus ? <Badge value={d.submissionStatus} /> : 'None yet'}
                {d.packageSha256 && <span className="mono small"> SHA-256 {d.packageSha256.slice(0, 16)}…</span>}
              </dd>
              <dt>Recordings</dt>
              <dd>{!d.evidence ? 'Not yet submitted' : d.evidence.expected.length === 0 ? 'Not recorded' : d.evidence.complete ? 'Complete' : 'Incomplete'}</dd>
              <dt>Time offline</dt>
              <dd>{d.offline.interruptions ? `${d.offline.interruptions} times, ${formatDuration(d.offline.totalSeconds * 1000)} in all` : 'None'}</dd>
            </dl>

            <h2>Answers</h2>
            <ol className="marking">
              {d.answers.map((a) => (
                <li key={a.questionId}>
                  <strong>{a.prompt}</strong>
                  <div>
                    {!a.answer ? (
                      <span className="muted">Not answered</span>
                    ) : a.answer.choices ? (
                      a.answer.choices.join(', ')
                    ) : a.answer.name ? (
                      `File: ${a.answer.name}`
                    ) : (
                      <blockquote className="answer">{a.answer.text}</blockquote>
                    )}
                  </div>
                  <span className="small">
                    {d.status === 'active' ? `Worth ${a.maxPoints}` : a.awarded === null ? 'To be marked' : `${a.awarded} of ${a.maxPoints}`}
                  </span>
                </li>
              ))}
            </ol>

            <h2>Timeline</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Details</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {d.timeline.map((t, i) => (
                    <tr key={i} className={t.severity === 'high' ? 'flagged' : undefined}>
                      <td className="small">{formatDateTime(t.occurredAt)}</td>
                      <td>{label(t.type)}</td>
                      <td className="small">{eventDetail(t.type, t.data)}</td>
                      <td className="small">{t.by ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Loading>
    </Page>
  );
}
