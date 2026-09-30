import { useEffect, useState } from 'react';
import { ActionButton, Badge, ErrorText, Loading, Page, Stat } from '../components/ui';
import { download, request } from '../lib/api';
import { formatDateTime, formatTime, label } from '../lib/format';
import { href } from '../lib/router';
import { can, useMe } from '../lib/session';
import { useApi } from '../lib/useApi';
import { Chunk } from '../components/media';

interface ResultRow {
  attemptId: string;
  fullName: string;
  studentId: string | null;
  email: string;
  submittedAt: string;
  submittedBy: string;
  score: number | null;
  maxScore: number | null;
  percent: number | null;
  status: string;
  violations: number;
}

interface ResultsData {
  summary: { submitted: number; pending: number; marked: number; moderated: number; released: number };
  items: ResultRow[];
}

export function Results({ sessionId }: { sessionId: string }) {
  const me = useMe();
  const results = useApi<ResultsData>(`/sessions/${sessionId}/results`);
  const [notice, setNotice] = useState<string | null>(null);
  const s = results.data?.summary;

  return (
    <Page
      title="Results"
      back={can(me, 'session:manage') ? { href: href('sessions', sessionId), text: 'Session' } : { href: href('marking'), text: 'Marking and results' }}
      actions={
        <>
          <ActionButton onClick={() => download(`/sessions/${sessionId}/results?format=csv`, 'results.csv')}>Download CSV</ActionButton>
          {can(me, 'result:release') && (
            <ActionButton
              className="primary"
              disabled={!s?.marked && !s?.moderated}
              confirm="Release every fully marked result? Candidates see their score straight away and it can no longer be changed."
              onClick={async () => {
                const r = await request<{ released: number; stillPending: number; awaitingModeration: number }>('POST', `/sessions/${sessionId}/results/release`);
                setNotice(
                  `${r.released} result${r.released === 1 ? '' : 's'} released.` +
                    (r.stillPending ? ` ${r.stillPending} still need marking and were held back.` : '') +
                    (r.awaitingModeration ? ` ${r.awaitingModeration} still need moderation and were held back.` : ''),
                );
                await results.reload();
              }}
            >
              Release marked results
            </ActionButton>
          )}
        </>
      }
    >
      <ErrorText error={results.error} />
      {notice && (
        <p className="banner ok" role="status">
          {notice}
        </p>
      )}
      <Loading loading={results.loading} empty={results.data?.items.length === 0 && 'Nobody has submitted yet.'}>
        {s && (
          <div className="stats">
            <Stat label="submitted" value={s.submitted} />
            <Stat label="waiting for a marker" value={s.pending} tone={s.pending ? 'warn' : ''} />
            <Stat label="marked, not released" value={s.marked} />
            {s.moderated > 0 && <Stat label="moderated, not released" value={s.moderated} />}
            <Stat label="released" value={s.released} tone="ok" />
          </div>
        )}
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Submitted</th>
              <th>Rule breaks</th>
              <th>Score</th>
              <th>Status</th>
              {can(me, 'result:mark') && <th />}
            </tr>
          </thead>
          <tbody>
            {results.data?.items.map((r) => (
              <tr key={r.attemptId}>
                <td>
                  {r.fullName} <span className="muted small">{r.studentId}</span>
                </td>
                <td className="small">
                  {formatDateTime(r.submittedAt)} {r.submittedBy !== 'candidate' && <span className="muted">({label(r.submittedBy)})</span>}
                </td>
                <td className={r.violations ? 'bad' : ''}>{r.violations}</td>
                <td>
                  {r.score} / {r.maxScore} {r.percent !== null && <span className="muted small">({r.percent}%)</span>}
                </td>
                <td>
                  <Badge value={r.status} />
                </td>
                {can(me, 'result:mark') && (
                  <td>
                    <a href={href('marking', r.attemptId)}>{r.status === 'pending' ? 'Mark' : 'View'}</a>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Loading>
    </Page>
  );
}

interface MarkingQuestion {
  id: string;
  type: string;
  prompt: string;
  options: { id: string; label: string; correct: boolean }[];
  answer: { optionId?: string; optionIds?: string[]; text?: string; fileId?: string; name?: string } | null;
  maxPoints: number;
  awarded: number | null;
  auto: boolean;
  comment: string | null;
}

interface MarkingData {
  candidate: { fullName: string; studentId: string | null };
  sessionId: string;
  sessionName: string;
  examName: string;
  status: string;
  score: number;
  maxScore: number;
  needsManual: number;
  moderation: { required: boolean; moderatedAt: string | null; moderatedBy: string | null };
  questions: MarkingQuestion[];
}

function answered(q: MarkingQuestion): boolean {
  return Boolean(q.answer?.text?.trim() || q.answer?.fileId || q.answer?.optionId || q.answer?.optionIds?.length);
}

/** The choices of a question, with the candidate's marked and the correct ones labelled. */
function Options({ q }: { q: MarkingQuestion }) {
  return (
    <ul className="options">
      {q.options.map((o) => {
        const chosen = q.answer?.optionId === o.id || q.answer?.optionIds?.includes(o.id);
        return (
          <li key={o.id} className={o.correct ? 'correct' : chosen ? 'wrong' : ''}>
            {chosen ? '● ' : '○ '}
            {o.label}
            {o.correct && <span className="muted small"> (correct)</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function Marking({ attemptId }: { attemptId: string }) {
  const me = useMe();
  const data = useApi<MarkingData>(`/marking/attempts/${attemptId}`);
  const [marks, setMarks] = useState<Record<string, { points: string; comment: string }>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const d = data.data;
  const locked = d?.status === 'released';

  useEffect(() => {
    if (!d) return;
    setMarks(
      Object.fromEntries(
        d.questions.filter((q) => !q.auto).map((q) => [q.id, { points: q.awarded === null ? '' : String(q.awarded), comment: q.comment ?? '' }]),
      ),
    );
  }, [d]);

  const answeredManual = d?.questions.filter((q) => !q.auto && answered(q)) ?? [];

  return (
    <Page title={d ? `Marking: ${d.candidate.fullName}` : 'Marking'} back={d ? { href: href('sessions', d.sessionId, 'results'), text: 'Results' } : undefined}>
      <ErrorText error={data.error} />
      <Loading loading={data.loading}>
        {d && (
          <>
            <p className="muted">
              {d.examName} · {d.sessionName} · <Badge value={d.status} /> · {d.score} of {d.maxScore} so far
              {d.needsManual > 0 && `, ${d.needsManual} answer${d.needsManual > 1 ? 's' : ''} to mark`}
            </p>
            {locked && <p className="banner warn">This result has been released and can no longer be changed.</p>}
            {d.moderation.required && !locked && (
              <div className="card">
                <h3>Moderation</h3>
                {d.status === 'moderated' ? (
                  <p>
                    Marks confirmed by {d.moderation.moderatedBy ?? 'a moderator'}
                    {d.moderation.moderatedAt && ` on ${new Date(d.moderation.moderatedAt).toLocaleString()}`}. Changing a mark sends the script back for moderation.
                  </p>
                ) : d.status === 'marked' ? (
                  <>
                    <p className="muted">This exam needs a second person to confirm the marks before the result can be released. It cannot be someone who marked this script.</p>
                    {can(me, 'result:release') && (
                      <ActionButton
                        onClick={async () => {
                          await request('POST', `/marking/attempts/${attemptId}/moderate`);
                          await data.reload();
                        }}
                      >
                        Confirm the marks
                      </ActionButton>
                    )}
                  </>
                ) : (
                  <p className="muted">Moderation opens once every answer is marked.</p>
                )}
              </div>
            )}
            <ol className="marking">
              {d.questions.map((q, i) => (
                <li key={q.id} className="card">
                  <p className="muted small">
                    Question {i + 1} · {label(q.type)} · {q.maxPoints} {q.maxPoints === 1 ? 'mark' : 'marks'}
                  </p>
                  <h3>{q.prompt}</h3>
                  {q.options.length > 0 && <Options q={q} />}
                  {q.auto ? (
                    <>
                      <p>
                        <strong>
                          {q.awarded} / {q.maxPoints}
                        </strong>{' '}
                        <span className="muted small">marked automatically{q.answer ? '' : ', not answered'}</span>
                      </p>
                    </>
                  ) : (
                    <>
                      {q.options.length > 0 ? (
                        !q.answer?.optionId && !q.answer?.optionIds?.length && <p className="muted">Not answered. Scores 0.</p>
                      ) : q.answer?.fileId ? (
                        <p className="answer">
                          <ActionButton onClick={() => download(`/marking/attempts/${attemptId}/files/${q.answer!.fileId}`, q.answer!.name ?? 'answer')}>
                            Download {q.answer.name ?? 'the file'}
                          </ActionButton>
                        </p>
                      ) : (
                        <blockquote className="answer">{q.answer?.text?.trim() ? q.answer.text : <span className="muted">Not answered. Scores 0.</span>}</blockquote>
                      )}
                      {answered(q) && marks[q.id] && (
                        <div className="row">
                          <label className="field narrow">
                            <span>Marks out of {q.maxPoints}</span>
                            <input
                              type="number"
                              min={0}
                              max={q.maxPoints}
                              step="0.5"
                              disabled={locked}
                              value={marks[q.id]!.points}
                              onChange={(e) => setMarks({ ...marks, [q.id]: { ...marks[q.id]!, points: e.target.value } })}
                            />
                          </label>
                          <label className="field grow">
                            <span>Comment (optional, for the record)</span>
                            <input disabled={locked} value={marks[q.id]!.comment} onChange={(e) => setMarks({ ...marks, [q.id]: { ...marks[q.id]!, comment: e.target.value } })} />
                          </label>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ol>
            {!locked && answeredManual.length > 0 && (
              <div className="row sticky-actions">
                <ActionButton
                  className="primary"
                  onClick={async () => {
                    const entries = answeredManual
                      .map((q) => ({ q, m: marks[q.id]! }))
                      .filter(({ m }) => m.points.trim() !== '')
                      .map(({ q, m }) => ({ questionId: q.id, points: Number(m.points), ...(m.comment.trim() ? { comment: m.comment.trim() } : {}) }));
                    if (!entries.length) throw new Error('Enter at least one mark');
                    const r = await request<{ score: number; maxScore: number; needsManual: number }>('PUT', `/marking/attempts/${attemptId}`, { marks: entries });
                    setSaved(`Saved. Score ${r.score} of ${r.maxScore}.${r.needsManual ? ` ${r.needsManual} still to mark.` : ' Marking complete.'}`);
                    await data.reload();
                  }}
                >
                  Save marks
                </ActionButton>
                {saved && (
                  <span className="banner ok" role="status">
                    {saved}
                  </span>
                )}
              </div>
            )}
            {can(me, 'recording:view') && <Recordings attemptId={attemptId} />}
          </>
        )}
      </Loading>
    </Page>
  );
}

interface RecordingsData {
  submission: string | null;
  evidence: { expected: string[]; missing: Record<string, number[]>; incomplete: string[]; uncovered?: string[]; complete: boolean };
  streams: { type: string; chunks: { id: string; sequence: number; startTime: string; endTime: string; sizeBytes: number; contentType: string }[] }[];
}

const STREAM_TEXT: Record<string, string> = { camera: 'Camera', screen: 'Screen', audio: 'Microphone' };

function Recordings({ attemptId }: { attemptId: string }) {
  const rec = useApi<RecordingsData>(`/attempts/${attemptId}/recordings`);
  const d = rec.data;
  if (rec.error) return <ErrorText error={rec.error} />;
  if (!d || d.evidence.expected.length === 0) return null;
  return (
    <section className="card">
      <h2>Recording</h2>
      <p>
        {d.evidence.complete ? (
          <Badge value="complete" tone="ok" />
        ) : (
          <Badge value="incomplete" tone="warn" />
        )}{' '}
        <span className="muted small">
          Submission {label(d.submission)}.
          {d.evidence.incomplete.length > 0 && ` Not finished: ${d.evidence.incomplete.map((s) => STREAM_TEXT[s] ?? s).join(', ')}.`}
          {(d.evidence.uncovered ?? []).length > 0 &&
            ` Does not cover the whole exam: ${(d.evidence.uncovered ?? []).map((s) => STREAM_TEXT[s] ?? s).join(', ')}.`}
          {Object.entries(d.evidence.missing).map(([s, gaps]) => ` ${STREAM_TEXT[s] ?? s} is missing part${gaps.length > 1 ? 's' : ''} ${gaps.join(', ')}.`)}
        </span>
      </p>
      {d.streams.map((s) => (
        <div key={s.type} className="stream">
          <h3>
            {STREAM_TEXT[s.type] ?? s.type} <span className="muted small">({s.chunks.length} part{s.chunks.length === 1 ? '' : 's'})</span>
          </h3>
          {s.chunks.length === 0 ? (
            <p className="muted small">Nothing was received.</p>
          ) : (
            <div className="chunks">
              {s.chunks.map((c) => (
                <Chunk key={c.id} id={c.id} contentType={c.contentType} label={`${formatTime(c.startTime)}`} />
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

interface SessionRow {
  id: string;
  name: string;
  status: string;
  startsAt: string;
  examName: string;
  candidates: number;
  submitted: number;
}

/** Sessions with work to mark or results to release. */
export function MarkingSessions() {
  const list = useApi<{ items: SessionRow[] }>('/sessions?limit=100');
  const items = (list.data?.items ?? []).filter((s) => s.submitted > 0);
  return (
    <Page title="Marking and results">
      <p className="muted">Sessions where candidates have submitted. Open one to mark free text answers and release results.</p>
      <ErrorText error={list.error} />
      <Loading loading={list.loading} empty={items.length === 0 && 'Nobody has submitted an exam yet.'}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Exam</th>
                <th>Started</th>
                <th>Submitted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.examName}</td>
                  <td>{formatDateTime(s.startsAt)}</td>
                  <td>
                    {s.submitted} of {s.candidates}
                  </td>
                  <td>
                    <a href={href('sessions', s.id, 'results')}>Open results</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Loading>
    </Page>
  );
}
