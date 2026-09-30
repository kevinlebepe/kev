import { useState } from 'react';
import { ActionButton, Badge, ErrorText, Field, Form, Loading, Page } from '../components/ui';
import { request } from '../lib/api';
import { formatDateTime, label } from '../lib/format';
import { href } from '../lib/router';
import { useApi } from '../lib/useApi';

// Support cases (spec section 23). Candidates raise them from the exam app;
// questions about rules, eligibility and accommodations are the
// organisation's, while sign in, device and exam problems are marked as
// platform problems so platform support can see them too.

interface CaseRow {
  id: string;
  category: string;
  scope: 'organisation' | 'platform';
  status: 'open' | 'in_progress' | 'resolved';
  summary: string;
  details: string | null;
  reply: string | null;
  createdAt: string;
  repliedAt: string | null;
  repliedBy: string | null;
  candidateName: string | null;
  candidateEmail: string | null;
}

interface CaseDetail extends CaseRow {
  studentId: string | null;
  candidateStatus: string | null;
  identityStatus: string | null;
  sessionName: string | null;
  sessionStartsAt: string | null;
  entitlementStatus: string | null;
  lastDeviceCheck: { passed: boolean; checks: { key: string; passed: boolean; message: string }[]; os: { platform?: string; version?: string } | null; appVersion: string | null; checkedAt: string } | null;
}

const SCOPE_TEXT = { organisation: 'Your organisation', platform: 'Platform' };

export function Support({ caseId }: { caseId?: string }) {
  const [status, setStatus] = useState('open');
  const list = useApi<{ items: CaseRow[] }>(`/support-cases?status=${status}`);
  return (
    <Page title="Support">
      <p className="muted">Requests from candidates. Each one you open is recorded in the audit log.</p>
      <Field label="Show">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
      </Field>
      <div className="split">
        <div>
          <ErrorText error={list.error} />
          <Loading loading={list.loading} empty={list.data?.items.length === 0 && 'No requests.'}>
            <ul className="cases">
              {list.data?.items.map((c) => (
                <li key={c.id} className={c.id === caseId ? 'card selected' : 'card'}>
                  <a href={href('support', c.id)}>
                    <strong>{c.summary}</strong>
                  </a>
                  <div className="small muted">
                    {c.candidateName} · {label(c.category)} · {SCOPE_TEXT[c.scope]} · {formatDateTime(c.createdAt)}
                  </div>
                  <Badge value={c.status} />
                </li>
              ))}
            </ul>
          </Loading>
        </div>
        {caseId && <CasePanel id={caseId} onChanged={list.reload} />}
      </div>
    </Page>
  );
}

function CasePanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const d = useApi<CaseDetail>(`/support-cases/${id}`);
  const c = d.data;
  const [reply, setReply] = useState('');
  const [resolve, setResolve] = useState(true);
  return (
    <aside className="card panel" aria-labelledby="case-title">
      <ErrorText error={d.error} />
      {c && (
        <>
          <h2 id="case-title">{c.summary}</h2>
          <p>
            <Badge value={c.status} /> {label(c.category)}, {SCOPE_TEXT[c.scope].toLowerCase()} · {formatDateTime(c.createdAt)}
          </p>
          {c.details && <blockquote className="answer">{c.details}</blockquote>}
          <dl className="facts">
            <dt>Candidate</dt>
            <dd>
              {c.candidateName}
              {c.studentId && ` (${c.studentId})`}, {c.candidateEmail}
            </dd>
            <dt>Account</dt>
            <dd>
              {label(c.candidateStatus)}, identity {label(c.identityStatus).toLowerCase()}
            </dd>
            {c.sessionName && (
              <>
                <dt>Exam</dt>
                <dd>
                  {c.sessionName}, {formatDateTime(c.sessionStartsAt)} <Badge value={c.entitlementStatus} />
                </dd>
              </>
            )}
            {c.lastDeviceCheck && (
              <>
                <dt>Last device check</dt>
                <dd>
                  {c.lastDeviceCheck.passed ? 'Passed' : 'Failed'} on {formatDateTime(c.lastDeviceCheck.checkedAt)}
                  {c.lastDeviceCheck.os && `, ${c.lastDeviceCheck.os.platform ?? ''} ${c.lastDeviceCheck.os.version ?? ''}`}
                  {!c.lastDeviceCheck.passed && (
                    <ul className="small">
                      {c.lastDeviceCheck.checks
                        .filter((k) => !k.passed)
                        .map((k) => (
                          <li key={k.key}>{k.message}</li>
                        ))}
                    </ul>
                  )}
                </dd>
              </>
            )}
          </dl>
          {c.reply && (
            <>
              <h3>Reply sent</h3>
              <blockquote className="answer">{c.reply}</blockquote>
              <p className="muted small">
                By {c.repliedBy} on {formatDateTime(c.repliedAt)}
              </p>
            </>
          )}
          <Form
            submitText="Send reply"
            onSubmit={async () => {
              await request('PATCH', `/support-cases/${id}`, { reply: reply.trim(), ...(resolve ? { status: 'resolved' } : {}) });
              setReply('');
              await d.reload();
              onChanged();
            }}
          >
            <Field label={c.reply ? 'Send another reply' : 'Reply to the candidate'} hint="The candidate gets an email and reads the reply in the exam app, under Help.">
              <textarea rows={4} maxLength={5000} value={reply} onChange={(e) => setReply(e.target.value)} required />
            </Field>
            <label className="check">
              <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} /> Mark as resolved
            </label>
          </Form>
          <div className="row">
            {c.status !== 'in_progress' && (
              <ActionButton
                onClick={async () => {
                  await request('PATCH', `/support-cases/${id}`, { status: 'in_progress' });
                  await d.reload();
                  onChanged();
                }}
              >
                Mark in progress
              </ActionButton>
            )}
            <ActionButton
              onClick={async () => {
                await request('PATCH', `/support-cases/${id}`, { scope: c.scope === 'platform' ? 'organisation' : 'platform' });
                await d.reload();
                onChanged();
              }}
            >
              {c.scope === 'platform' ? 'Handle it ourselves' : 'Pass to platform support'}
            </ActionButton>
          </div>
        </>
      )}
    </aside>
  );
}
