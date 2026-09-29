import { useState } from 'react';
import { ActionButton, Badge, ErrorText, Field, Form, Loading, Page } from '../components/ui';
import { request } from '../lib/api';
import { useApi } from '../lib/useApi';

interface Invigilator {
  id: string;
  displayName: string;
  email: string;
  status: string;
  maxActive: number;
  load: number;
  liveStatus: string;
}

export function Invigilators() {
  const list = useApi<{ items: Invigilator[] }>('/invigilators?limit=100');
  const [adding, setAdding] = useState(false);
  const update = async (i: Invigilator, status: string) => {
    await request('PATCH', `/invigilators/${i.id}`, { status });
    await list.reload();
  };
  return (
    <Page title="Invigilators" actions={<button onClick={() => setAdding(!adding)}>Add an invigilator</button>}>
      {adding && <AddInvigilator onDone={() => (setAdding(false), list.reload())} onCancel={() => setAdding(false)} />}
      <ErrorText error={list.error} />
      <Loading loading={list.loading} empty={list.data?.items.length === 0 && 'No invigilators yet.'}>
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Status</th>
              <th>Watching now</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((i) => (
              <tr key={i.id}>
                <td>{i.displayName}</td>
                <td>{i.email}</td>
                <td>
                  <Badge value={i.status} />
                </td>
                <td>
                  {i.load} of {Math.min(i.maxActive, 10)} <Badge value={i.liveStatus} />
                </td>
                <td className="row">
                  {i.status === 'active' ? (
                    <ActionButton className="small" onClick={() => update(i, 'paused')}>
                      Pause
                    </ActionButton>
                  ) : (
                    <ActionButton className="small" onClick={() => update(i, 'active')}>
                      Make active
                    </ActionButton>
                  )}
                  {i.status !== 'suspended' && (
                    <ActionButton className="small danger" confirm={`Suspend ${i.displayName}? They lose access to the live console at once.`} onClick={() => update(i, 'suspended')}>
                      Suspend
                    </ActionButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Loading>
      <p className="muted small">A paused invigilator keeps the candidates they already have but gets no new ones.</p>
    </Page>
  );
}

function AddInvigilator({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [maxActive, setMaxActive] = useState(10);
  return (
    <Form
      submitText="Add invigilator"
      onCancel={onCancel}
      onSubmit={async () => {
        await request('POST', '/invigilators', {
          displayName: displayName.trim(),
          email: email.trim(),
          maxActive,
          ...(password ? { password } : {}),
        });
        onDone();
      }}
    >
      <h2>Add an invigilator</h2>
      <div className="grid2">
        <Field label="Full name">
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </Field>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Starting password" hint="At least 12 characters. Share it privately. Leave empty if they already have an ExamGuard account.">
          <input type="password" value={password} minLength={12} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Most candidates at once" hint="Never more than 10.">
          <input type="number" min={1} max={10} value={maxActive} onChange={(e) => setMaxActive(Number(e.target.value))} />
        </Field>
      </div>
    </Form>
  );
}
