import { useState } from 'react';
import { Badge, ErrorText, Field, Form, Loading, Page } from '../components/ui';
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
    </Page>
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
        <Field label="Starting password" hint="At least 12 characters. Leave empty if they already have an ExamGuard account.">
          <input type="password" value={password} minLength={12} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
    </Form>
  );
}
