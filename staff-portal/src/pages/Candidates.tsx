import { useState } from 'react';
import { ActionButton, Badge, ErrorText, Field, Form, Loading, Page } from '../components/ui';
import { download, request } from '../lib/api';
import { formatDateTime, parseCandidateCsv } from '../lib/format';
import { can, useMe } from '../lib/session';
import { useApi } from '../lib/useApi';

export interface Candidate {
  id: string;
  email: string;
  fullName: string;
  studentId: string | null;
  programme: string | null;
  status: string;
  identityStatus: string;
  createdAt: string;
}

const STATUSES = ['', 'pending_approval', 'approved', 'invited', 'registered', 'rejected', 'blocked'];

/** Which actions make sense for a candidate in each status. */
const ACTIONS: Record<string, ('approve' | 'reject' | 'block' | 'unblock')[]> = {
  pending_approval: ['approve', 'reject'],
  registered: ['approve', 'reject'],
  approved: ['block'],
  rejected: ['approve'],
  blocked: ['unblock'],
  invited: [],
};

export function Candidates() {
  const me = useMe();
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [mode, setMode] = useState<'none' | 'invite' | 'import'>('none');
  const [search, setSearch] = useState('');
  const list = useApi<{ items: Candidate[]; nextOffset: number | null }>(`/candidates?limit=100&offset=${offset}${status ? `&status=${status}` : ''}`);

  const shown = (list.data?.items ?? []).filter((c) => {
    const q = search.trim().toLowerCase();
    return !q || [c.fullName, c.email, c.studentId ?? ''].some((v) => v.toLowerCase().includes(q));
  });

  async function act(c: Candidate, action: string) {
    let body: { reason?: string } = {};
    if (action === 'reject' || action === 'block') {
      const reason = window.prompt(`Reason to ${action} ${c.fullName} (kept in the audit log):`);
      if (reason === null) return;
      body = reason.trim() ? { reason: reason.trim() } : {};
    }
    await request('POST', `/candidates/${c.id}/${action}`, body);
    await list.reload();
  }

  // Erasure cannot be undone, so the owner types the email address back.
  async function erase(c: Candidate) {
    const typed = window.prompt(
      `Erase ${c.fullName}? Their name, email, answers, recordings and files are removed for good, and their sign in account too if they use it nowhere else. Scores and the audit trail stay. Type their email address to confirm:`,
    );
    if (!typed) return;
    await request('POST', `/candidates/${c.id}/erase`, { confirmEmail: typed.trim() });
    await list.reload();
  }

  return (
    <Page
      title="Candidates"
      actions={
        can(me, 'candidate:invite') && (
          <>
            <button onClick={() => setMode(mode === 'invite' ? 'none' : 'invite')}>Invite a candidate</button>
            <button onClick={() => setMode(mode === 'import' ? 'none' : 'import')}>Import a list</button>
          </>
        )
      }
    >
      {mode === 'invite' && <InviteForm onDone={() => (setMode('none'), list.reload())} onCancel={() => setMode('none')} />}
      {mode === 'import' && <ImportForm onDone={() => list.reload()} onCancel={() => setMode('none')} />}

      <div className="filters">
        <Field label="Status">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s ? s.replaceAll('_', ' ') : 'All'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Search this page">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email or student number" />
        </Field>
      </div>

      <ErrorText error={list.error} />
      <Loading loading={list.loading} empty={shown.length === 0 && 'No candidates match.'}>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Student number</th>
              <th>Status</th>
              <th>Identity</th>
              <th>Added</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id}>
                <td>{c.fullName}</td>
                <td>{c.email}</td>
                <td>{c.studentId}</td>
                <td>
                  <Badge value={c.status} />
                </td>
                <td className="muted small">{c.identityStatus.replaceAll('_', ' ')}</td>
                <td className="muted small">{formatDateTime(c.createdAt)}</td>
                <td className="row">
                  {can(me, 'candidate:approve') &&
                    (ACTIONS[c.status] ?? []).map((a) => (
                      <ActionButton key={a} className={a === 'approve' ? 'primary small' : 'small'} onClick={() => act(c, a)}>
                        {a[0]!.toUpperCase() + a.slice(1)}
                      </ActionButton>
                    ))}
                  <ActionButton className="small" onClick={() => download(`/candidates/${c.id}/export`, `candidate-${c.id}.json`)}>
                    Export data
                  </ActionButton>
                  {can(me, 'organisation:manage_security') && !c.email.endsWith('@erased.invalid') && (
                    <ActionButton className="small danger" onClick={() => erase(c)}>
                      Erase
                    </ActionButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Loading>
      <div className="row pager">
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>
          ‹ Previous
        </button>
        <button disabled={list.data?.nextOffset == null} onClick={() => setOffset(list.data!.nextOffset!)}>
          Next ›
        </button>
      </div>
    </Page>
  );
}

function InviteForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [studentId, setStudentId] = useState('');
  return (
    <Form
      submitText="Send invitation"
      onCancel={onCancel}
      onSubmit={async () => {
        await request('POST', '/candidates/invite', {
          email: email.trim(),
          fullName: fullName.trim(),
          ...(studentId.trim() ? { studentId: studentId.trim() } : {}),
        });
        onDone();
      }}
    >
      <h2>Invite a candidate</h2>
      <p className="muted">They receive an email with a link to set a password. You approve them once they have accepted.</p>
      <div className="grid2">
        <Field label="Full name">
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </Field>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Student or staff number (optional)">
          <input value={studentId} onChange={(e) => setStudentId(e.target.value)} />
        </Field>
      </div>
    </Form>
  );
}

function ImportForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const parsed = parseCandidateCsv(text);
  return (
    <Form
      submitText={`Invite ${parsed.length} candidate${parsed.length === 1 ? '' : 's'}`}
      onCancel={onCancel}
      onSubmit={async () => {
        if (!parsed.length) throw new Error('Paste at least one line: email, full name');
        const res = await request<{ created: number; skipped: unknown[] }>('POST', '/candidates/import', { candidates: parsed });
        setResult(`${res.created} invited. ${res.skipped.length} skipped because they were already on the list.`);
        setText('');
        onDone();
      }}
    >
      <h2>Import a list</h2>
      <p className="muted">
        Paste from a spreadsheet saved as CSV. One candidate per line: <code>email, full name, student number, programme</code>. The last two are
        optional, and a header line is ignored.
      </p>
      <Field label="Candidates">
        <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'thandi@example.ac.za, Thandi Mokoena, 2024001\n'} />
      </Field>
      {result && (
        <p className="banner ok" role="status">
          {result}
        </p>
      )}
    </Form>
  );
}
