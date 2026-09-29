import { useState } from 'react';
import { ActionButton, Badge, ErrorText, Field, Form, Loading, Page, Stat } from '../components/ui';
import { request } from '../lib/api';
import { formatDateTime, isoToLocal, label, localToIso } from '../lib/format';
import { href, navigate } from '../lib/router';
import { can, useMe } from '../lib/session';
import { useApi } from '../lib/useApi';
import type { Candidate } from './Candidates';

interface SessionRow {
  id: string;
  name: string;
  status: string;
  startsAt: string;
  endsAt: string;
  examName: string;
  examVersion: number;
  candidates: number;
  submitted: number;
}

interface ExamVersion {
  id: string;
  code: string;
  name: string;
  version: number;
  publishedAt: string;
  durationMinutes: number | null;
}

export function Sessions() {
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');
  const list = useApi<{ items: SessionRow[] }>(`/sessions?limit=100${status ? `&status=${status}` : ''}`);
  return (
    <Page title="Sessions" actions={<button onClick={() => setCreating(!creating)}>New session</button>}>
      {creating && <CreateSession onCancel={() => setCreating(false)} />}
      <div className="filters">
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['', 'scheduled', 'open', 'closed', 'cancelled'].map((s) => (
              <option key={s} value={s}>
                {s ? label(s) : 'All'}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorText error={list.error} />
      <Loading loading={list.loading} empty={list.data?.items.length === 0 && 'No sessions yet.'}>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Exam</th>
              <th>Starts</th>
              <th>Ends</th>
              <th>Status</th>
              <th>Candidates</th>
              <th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((s) => (
              <tr key={s.id}>
                <td>
                  <a href={href('sessions', s.id)}>{s.name}</a>
                </td>
                <td>
                  {s.examName} <span className="muted small">v{s.examVersion}</span>
                </td>
                <td>{formatDateTime(s.startsAt)}</td>
                <td>{formatDateTime(s.endsAt)}</td>
                <td>
                  <Badge value={s.status} />
                </td>
                <td>{s.candidates}</td>
                <td>{s.submitted}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Loading>
    </Page>
  );
}

function CreateSession({ onCancel }: { onCancel: () => void }) {
  const versions = useApi<{ items: ExamVersion[] }>('/exam-versions?limit=100');
  const [versionId, setVersionId] = useState('');
  const [name, setName] = useState('');
  const start = new Date(Date.now() + 60 * 60_000);
  start.setMinutes(0, 0, 0);
  const [startsAt, setStartsAt] = useState(isoToLocal(start));
  const [endsAt, setEndsAt] = useState(isoToLocal(new Date(start.getTime() + 3 * 60 * 60_000)));

  return (
    <Form
      submitText="Create session"
      onCancel={onCancel}
      onSubmit={async () => {
        const created = await request<{ id: string }>('POST', '/sessions', {
          examVersionId: versionId,
          name: name.trim(),
          startsAt: localToIso(startsAt),
          endsAt: localToIso(endsAt),
        });
        navigate('sessions', created.id);
      }}
    >
      <h2>New session</h2>
      <ErrorText error={versions.error} />
      {versions.data?.items.length === 0 && <p className="banner warn">Publish an exam first. Sessions always use a published version.</p>}
      <div className="grid2">
        <Field label="Exam version">
          <select value={versionId} onChange={(e) => setVersionId(e.target.value)} required>
            <option value="">Choose…</option>
            {versions.data?.items.map((v) => (
              <option key={v.id} value={v.id}>
                {v.code} · {v.name} · version {v.version}
                {v.durationMinutes ? ` · ${v.durationMinutes} min` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Session name" hint="For example: Main sitting, 14 October morning.">
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Starts">
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required />
        </Field>
        <Field label="Ends" hint="No attempt runs past this time.">
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required />
        </Field>
      </div>
    </Form>
  );
}

interface SessionStatus {
  id: string;
  name: string;
  status: string;
  startsAt: string;
  endsAt: string;
  examVersion: number;
  examId: string;
  assignments: Record<string, number>;
  invigilation: {
    covered: number;
    uncovered: number;
    invigilators: { id: string; displayName: string; status: string; load: number }[];
  };
}

interface AttemptRow {
  candidateId: string;
  fullName: string;
  entitlementStatus: string;
  attemptId: string | null;
  status: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  score: number | null;
  maxScore: number | null;
  markingStatus: string | null;
  violations: number;
}

const NEXT: Record<string, { status: string; text: string; confirm: string }[]> = {
  scheduled: [
    { status: 'open', text: 'Open session', confirm: 'Open the session? Candidates can start once the start time is reached.' },
    { status: 'cancelled', text: 'Cancel session', confirm: 'Cancel this session? This cannot be undone.' },
  ],
  open: [
    { status: 'closed', text: 'Close session', confirm: 'Close the session? No new attempts can start. Running attempts continue to their deadline.' },
    { status: 'cancelled', text: 'Cancel session', confirm: 'Cancel this session? This cannot be undone.' },
  ],
};

export function SessionDetail({ id }: { id: string }) {
  const me = useMe();
  const status = useApi<SessionStatus>(`/sessions/${id}/status`);
  const attempts = useApi<{ items: AttemptRow[] }>(can(me, 'report:view') ? `/sessions/${id}/attempts?limit=100` : null);
  const [panel, setPanel] = useState<'none' | 'assign' | 'roster'>('none');
  const [allocation, setAllocation] = useState<string | null>(null);
  const s = status.data;
  const reload = () => Promise.all([status.reload(), attempts.reload()]);

  return (
    <Page
      title={s ? s.name : 'Session'}
      back={{ href: href('sessions'), text: 'Sessions' }}
      actions={
        s && (
          <>
            {(NEXT[s.status] ?? []).map((n) => (
              <ActionButton
                key={n.status}
                className={n.status === 'cancelled' ? 'danger' : 'primary'}
                confirm={n.confirm}
                onClick={async () => {
                  await request('PATCH', `/sessions/${id}`, { status: n.status });
                  await reload();
                }}
              >
                {n.text}
              </ActionButton>
            ))}
            {can(me, 'live:view') && <a className="button" href={href('live', id)}>Live console</a>}
            {can(me, 'report:view') && <a className="button" href={href('sessions', id, 'results')}>Results</a>}
          </>
        )
      }
    >
      <ErrorText error={status.error} />
      <Loading loading={status.loading}>
        {s && (
          <>
            <p>
              <Badge value={s.status} /> {formatDateTime(s.startsAt)} to {formatDateTime(s.endsAt)} · <a href={href('exams', s.examId)}>exam version {s.examVersion}</a>
            </p>
            <div className="stats">
              <Stat label="assigned" value={Object.values(s.assignments).reduce((a, b) => a + b, 0) - (s.assignments.revoked ?? 0)} />
              <Stat label="device check passed" value={s.assignments.precheck_complete ?? 0} />
              <Stat label="in progress" value={s.assignments.active ?? 0} />
              <Stat label="submitted" value={(s.assignments.submitted ?? 0) + (s.assignments.completed ?? 0)} />
              <Stat label="without an invigilator" value={s.invigilation.uncovered} tone={s.invigilation.uncovered ? 'warn' : ''} />
            </div>

            {['scheduled', 'open'].includes(s.status) && (
              <div className="row">
                {can(me, 'session:manage') && <button onClick={() => setPanel(panel === 'assign' ? 'none' : 'assign')}>Assign candidates</button>}
                {can(me, 'invigilation:allocate') && (
                  <>
                    <button onClick={() => setPanel(panel === 'roster' ? 'none' : 'roster')}>Roster invigilators</button>
                    <ActionButton
                      onClick={async () => {
                        const r = await request<{ assignments: unknown[]; unassigned: unknown[] }>('POST', '/live/assignments', { mode: 'auto', sessionId: id });
                        setAllocation(
                          `${r.assignments.length} candidate${r.assignments.length === 1 ? '' : 's'} allocated.` +
                            (r.unassigned.length ? ` ${r.unassigned.length} still need an invigilator: add more invigilators to the roster.` : ''),
                        );
                        await reload();
                      }}
                    >
                      Allocate candidates to invigilators
                    </ActionButton>
                  </>
                )}
              </div>
            )}
            {allocation && (
              <p className="banner ok" role="status">
                {allocation}
              </p>
            )}
            {panel === 'assign' && <AssignCandidates sessionId={id} onDone={() => (setPanel('none'), reload())} onCancel={() => setPanel('none')} />}
            {panel === 'roster' && <Roster sessionId={id} current={s.invigilation.invigilators.map((i) => i.id)} onDone={() => (setPanel('none'), reload())} onCancel={() => setPanel('none')} />}

            <section className="card">
              <h2>Invigilators on this session</h2>
              {s.invigilation.invigilators.length === 0 ? (
                <p className="muted">None rostered yet.</p>
              ) : (
                <ul className="plain">
                  {s.invigilation.invigilators.map((i) => (
                    <li key={i.id}>
                      {i.displayName} <Badge value={i.status} /> <span className="muted small">{i.load} candidates in this session</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {attempts.data && (
              <section className="card">
                <h2>Candidates</h2>
                <Loading loading={attempts.loading} empty={attempts.data.items.length === 0 && 'No candidates assigned yet.'}>
                  <div className="table-wrap">
        <table>
                    <thead>
                      <tr>
                        <th>Candidate</th>
                        <th>Entitlement</th>
                        <th>Started</th>
                        <th>Submitted</th>
                        <th>Rule breaks</th>
                        <th>Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attempts.data.items.map((a) => (
                        <tr key={a.candidateId}>
                          <td>{a.fullName}</td>
                          <td>
                            <Badge value={a.entitlementStatus} />
                          </td>
                          <td className="small">{formatDateTime(a.startedAt)}</td>
                          <td className="small">
                            {formatDateTime(a.submittedAt)} {a.submittedBy && a.submittedBy !== 'candidate' && <span className="muted">({label(a.submittedBy)})</span>}
                          </td>
                          <td className={a.violations ? 'bad' : ''}>{a.attemptId ? a.violations : ''}</td>
                          <td>
                            {a.score !== null ? `${a.score} / ${a.maxScore}` : ''} {a.markingStatus === 'pending' && <Badge value="pending" />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
        </div>
                </Loading>
              </section>
            )}
          </>
        )}
      </Loading>
    </Page>
  );
}

function AssignCandidates({ sessionId, onDone, onCancel }: { sessionId: string; onDone: () => void; onCancel: () => void }) {
  const approved = useApi<{ items: Candidate[] }>('/candidates?status=approved&limit=100');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  const items = approved.data?.items ?? [];
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  return (
    <Form
      submitText={`Assign ${picked.size} candidate${picked.size === 1 ? '' : 's'}`}
      onCancel={onCancel}
      onSubmit={async () => {
        if (!picked.size) throw new Error('Choose at least one candidate');
        const r = await request<{ assigned: string[]; rejected: { reason: string }[] }>('POST', '/assignments', { sessionId, candidateIds: [...picked] });
        const already = r.rejected.filter((x) => x.reason === 'already_assigned').length;
        setResult(`${r.assigned.length} assigned.${already ? ` ${already} were already on this session.` : ''}`);
        if (!r.rejected.length || r.rejected.length === already) onDone();
      }}
    >
      <h2>Assign candidates</h2>
      <p className="muted">Only approved candidates can be assigned. Each receives an email about the exam.</p>
      <ErrorText error={approved.error} />
      <Loading loading={approved.loading} empty={items.length === 0 && 'No approved candidates. Approve candidates under Candidates first.'}>
        <div className="row">
          <button type="button" className="small" onClick={() => setPicked(new Set(items.map((c) => c.id)))}>
            Select all
          </button>
          <button type="button" className="small" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
        <ul className="picklist">
          {items.map((c) => (
            <li key={c.id}>
              <label className="check">
                <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                <span>
                  {c.fullName} <span className="muted small">{c.email}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Loading>
      {result && (
        <p className="banner ok" role="status">
          {result}
        </p>
      )}
    </Form>
  );
}

function Roster({ sessionId, current, onDone, onCancel }: { sessionId: string; current: string[]; onDone: () => void; onCancel: () => void }) {
  const invigilators = useApi<{ items: { id: string; displayName: string; email: string; status: string }[] }>('/invigilators?limit=100');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const available = (invigilators.data?.items ?? []).filter((i) => !current.includes(i.id));
  return (
    <Form
      submitText="Add to roster"
      onCancel={onCancel}
      onSubmit={async () => {
        if (!picked.size) throw new Error('Choose at least one invigilator');
        await request('POST', `/sessions/${sessionId}/invigilators`, { invigilatorIds: [...picked] });
        onDone();
      }}
    >
      <h2>Roster invigilators</h2>
      <p className="muted">Each invigilator watches at most 10 candidates at a time.</p>
      <ErrorText error={invigilators.error} />
      <Loading loading={invigilators.loading} empty={available.length === 0 && 'Everyone is already rostered, or no invigilators exist yet. Add them under Invigilators.'}>
        <ul className="picklist">
          {available.map((i) => (
            <li key={i.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={picked.has(i.id)}
                  onChange={() => {
                    const next = new Set(picked);
                    if (next.has(i.id)) next.delete(i.id);
                    else next.add(i.id);
                    setPicked(next);
                  }}
                />
                <span>
                  {i.displayName} <span className="muted small">{i.email}</span> <Badge value={i.status} />
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Loading>
    </Form>
  );
}
