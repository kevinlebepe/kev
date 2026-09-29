import { useState } from 'react';
import { ActionButton, Badge, ErrorText, Field, Form, Loading, Page } from '../components/ui';
import { request } from '../lib/api';
import { label } from '../lib/format';
import { can, useMe } from '../lib/session';
import { useApi } from '../lib/useApi';

const ROLES = ['admin', 'exam_manager', 'invigilator', 'reviewer', 'support', 'owner'];
const ROLE_TEXT: Record<string, string> = {
  owner: 'Everything, including security settings',
  admin: 'Everything except security settings',
  exam_manager: 'Exams, sessions, candidates and results',
  invigilator: 'The live console, for allocated candidates',
  reviewer: 'Marking and reports',
  support: 'Looking up candidates',
};

export function Staff() {
  const me = useMe();
  const list = useApi<{ items: { id: string; email: string; displayName: string; role: string; status: string }[] }>(`/organisations/${me.organisationId}/users?limit=100`);
  const [adding, setAdding] = useState(false);
  return (
    <Page title="Staff" actions={<button onClick={() => setAdding(!adding)}>Add staff member</button>}>
      {adding && <AddStaff onDone={() => (setAdding(false), list.reload())} onCancel={() => setAdding(false)} />}
      <ErrorText error={list.error} />
      <Loading loading={list.loading}>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td>{u.email}</td>
                <td>
                  {label(u.role)} <span className="muted small">{ROLE_TEXT[u.role]}</span>
                </td>
                <td>
                  <Badge value={u.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Loading>
      <p className="muted small">Invigilators are added under Invigilators, so they can be rostered and allocated candidates.</p>
      {can(me, 'organisation:manage_security') && <Security />}
    </Page>
  );
}

/** The organisation's sign in policy. Owners only. */
function Security() {
  const me = useMe();
  const org = useApi<{ requireStaffMfa: boolean; recordingRetentionDays: number | null }>(`/organisations/${me.organisationId}`);
  if (!org.data) return <ErrorText error={org.error} />;
  const on = org.data.requireStaffMfa;
  return (
    <section className="card">
      <h2>Sign in security</h2>
      <p>
        Two factor sign in for all staff is <strong>{on ? 'required' : 'optional'}</strong>.{' '}
        {on
          ? 'Staff who have not turned it on are asked to before they can do anything else.'
          : 'When required, staff who have not turned it on must do so before they can do anything else.'}
      </p>
      {!on && !me.mfaEnabled && <p className="muted small">Turn it on for your own account first, under Your account.</p>}
      <ActionButton
        className={on ? '' : 'primary'}
        disabled={!on && !me.mfaEnabled}
        confirm={on ? 'Make two factor sign in optional for staff?' : 'Require two factor sign in for every staff member?'}
        onClick={async () => {
          await request('PATCH', `/organisations/${me.organisationId}`, { requireStaffMfa: !on });
          await org.reload();
        }}
      >
        {on ? 'Make it optional' : 'Require it for all staff'}
      </ActionButton>
      <p className="muted small">After 5 wrong passwords or codes in a row, an account is locked for 15 minutes. Anyone can reset a forgotten password by email.</p>
      <Retention current={org.data.recordingRetentionDays} onSaved={org.reload} />
    </section>
  );
}

function Retention({ current, onSaved }: { current: number | null; onSaved: () => void }) {
  const me = useMe();
  const [days, setDays] = useState(current === null ? '' : String(current));
  return (
    <Form
      submitText="Save"
      onSubmit={async () => {
        await request('PATCH', `/organisations/${me.organisationId}`, { recordingRetentionDays: days.trim() ? Number(days) : null });
        onSaved();
      }}
    >
      <h3>Keeping recordings</h3>
      <Field
        label="Delete recordings this many days after the exam"
        hint={`Leave empty to keep them until deleted by hand. Currently: ${current === null ? 'kept' : `${current} days`}.`}
      >
        <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
      </Field>
    </Form>
  );
}

function AddStaff({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const me = useMe();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('exam_manager');
  const roles = ROLES.filter((r) => r !== 'invigilator' && (r !== 'owner' || can(me, 'organisation:manage_security')));
  return (
    <Form
      submitText="Add staff member"
      onCancel={onCancel}
      onSubmit={async () => {
        await request('POST', `/organisations/${me.organisationId}/users`, {
          displayName: displayName.trim(),
          email: email.trim(),
          role,
          ...(password ? { password } : {}),
        });
        onDone();
      }}
    >
      <h2>Add a staff member</h2>
      <div className="grid2">
        <Field label="Full name">
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </Field>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Role" hint={ROLE_TEXT[role]}>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {label(r)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Starting password (optional)"
          hint="Leave empty to email them a link to choose their own, which is safer. Otherwise at least 12 characters, shared privately."
        >
          <input type="password" value={password} minLength={12} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
    </Form>
  );
}
