import { useState } from 'react';
import { ActionButton, Badge, Check, ErrorText, Field, Form, Loading, Page } from '../components/ui';
import { API_BASE, request, sendFile } from '../lib/api';
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
  const org = useApi<{
    requireStaffMfa: boolean;
    recordingRetentionDays: number | null;
    candidateNotice: string | null;
    allowAccessCodes: boolean;
    brandColour: string | null;
    hasLogo: boolean;
    slug: string;
  }>(`/organisations/${me.organisationId}`);
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
      <CandidateNotice current={org.data.candidateNotice} onSaved={org.reload} />
      <h3>Exam access codes</h3>
      <p>
        Access codes are <strong>{org.data.allowAccessCodes ? 'allowed' : 'turned off'}</strong>. A code lets one approved candidate whose identity is verified sign in
        for one exam, from an hour before it starts until it ends, when they cannot sign in the usual way. Session managers issue them on the session page.
      </p>
      <ActionButton
        onClick={async () => {
          await request('PATCH', `/organisations/${me.organisationId}`, { allowAccessCodes: !org.data!.allowAccessCodes });
          await org.reload();
        }}
      >
        {org.data.allowAccessCodes ? 'Turn access codes off' : 'Allow access codes'}
      </ActionButton>
      <Branding colour={org.data.brandColour} hasLogo={org.data.hasLogo} slug={org.data.slug} onSaved={org.reload} />
      <SingleSignOn />
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

/** The organisation's own notice to candidates about monitoring and their data (spec section 19). */
function CandidateNotice({ current, onSaved }: { current: string | null; onSaved: () => void }) {
  const me = useMe();
  const [text, setText] = useState(current ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <Form
      submitText="Save notice"
      onSubmit={async () => {
        setSaved(false);
        await request('PATCH', `/organisations/${me.organisationId}`, { candidateNotice: text.trim() ? text.trim() : null });
        setSaved(true);
        onSaved();
      }}
    >
      <h3>Notice to candidates</h3>
      <Field
        label="Shown before every exam"
        hint="For example what is recorded, why, who can see it and for how long. Candidates must tick that they agree before they can start, and their agreement is recorded with the exact text. Leave empty for no notice."
      >
        <textarea rows={6} maxLength={5000} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {saved && (
        <p className="banner ok" role="status">
          Notice saved. Candidates starting from now see this text.
        </p>
      )}
    </Form>
  );
}

/** What candidates see of the organisation: its colour and logo (spec section 5). */
function Branding({ colour, hasLogo, slug, onSaved }: { colour: string | null; hasLogo: boolean; slug: string; onSaved: () => void }) {
  const me = useMe();
  const [value, setValue] = useState(colour ?? '#1f5fbf');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <h3>Branding</h3>
      <p className="muted small">Candidates see your colour and logo on the sign in screen of the exam app once they type your organisation code, {slug}.</p>
      <div className="row">
        <label className="field narrow">
          <span>Colour</span>
          <input type="color" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <ActionButton
          onClick={async () => {
            await request('PATCH', `/organisations/${me.organisationId}`, { brandColour: value });
            onSaved();
          }}
        >
          Save colour
        </ActionButton>
        {colour && (
          <ActionButton
            className="link"
            onClick={async () => {
              await request('PATCH', `/organisations/${me.organisationId}`, { brandColour: null });
              onSaved();
            }}
          >
            Use the default
          </ActionButton>
        )}
      </div>
      <div className="row">
        {hasLogo && <img className="logo-preview" src={`${API_BASE}/public/organisations/${slug}/logo?v=${version}`} alt="Your logo" />}
        <label className="field narrow">
          <span>Logo, a PNG or JPEG up to 200 KB</span>
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setError(null);
              try {
                await sendFile('PUT', `/organisations/${me.organisationId}/logo`, file);
                setVersion(version + 1);
                onSaved();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </label>
        {hasLogo && (
          <ActionButton
            className="link"
            onClick={async () => {
              await request('DELETE', `/organisations/${me.organisationId}/logo`);
              onSaved();
            }}
          >
            Remove the logo
          </ActionButton>
        )}
      </div>
      <ErrorText error={error} />
    </>
  );
}

interface Provider {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  forStaff: boolean;
  forCandidates: boolean;
  createCandidates: boolean;
  trustMfa: boolean;
  enabled: boolean;
}

/** Sign in through the organisation's own identity provider, with OpenID Connect (spec section 3). */
function SingleSignOn() {
  const me = useMe();
  const list = useApi<{ callbackUrl: string; items: Provider[] }>(`/organisations/${me.organisationId}/identity-providers`);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', issuer: '', clientId: '', clientSecret: '', forStaff: true, forCandidates: true, createCandidates: false, trustMfa: true });
  const toggle = async (p: Provider, patch: Partial<Provider>) => {
    await request('PATCH', `/organisations/${me.organisationId}/identity-providers/${p.id}`, patch);
    await list.reload();
  };
  return (
    <>
      <h3>Single sign on</h3>
      <p className="muted small">
        Let people sign in with your own identity provider, such as Microsoft Entra ID or Google Workspace, using OpenID Connect. Register this return address with the
        provider: <code>{list.data?.callbackUrl}</code>
      </p>
      <ErrorText error={list.error} />
      {list.data?.items.map((p) => (
        <div key={p.id} className="card provider">
          <div className="row spread">
            <strong>{p.name}</strong>
            <Badge value={p.enabled ? 'active' : 'paused'} />
          </div>
          <p className="muted small">
            {p.issuer} · client {p.clientId} · {p.hasSecret ? 'secret stored' : 'no secret'}
          </p>
          <div className="row">
            <Check label="Staff" checked={p.forStaff} onChange={(v) => toggle(p, { forStaff: v })} />
            <Check label="Candidates" checked={p.forCandidates} onChange={(v) => toggle(p, { forCandidates: v })} />
            <Check label="Register new candidates for approval" checked={p.createCandidates} onChange={(v) => toggle(p, { createCandidates: v })} />
            <Check label="Trust its two factor sign in" checked={p.trustMfa} onChange={(v) => toggle(p, { trustMfa: v })} />
          </div>
          <div className="row">
            <ActionButton className="small" onClick={() => toggle(p, { enabled: !p.enabled })}>
              {p.enabled ? 'Turn off' : 'Turn on'}
            </ActionButton>
            <ActionButton
              className="small danger"
              confirm={`Remove ${p.name}? People who only sign in through it will need a password.`}
              onClick={async () => {
                await request('DELETE', `/organisations/${me.organisationId}/identity-providers/${p.id}`);
                await list.reload();
              }}
            >
              Remove
            </ActionButton>
          </div>
        </div>
      ))}
      {adding ? (
        <Form
          submitText="Add identity provider"
          onCancel={() => setAdding(false)}
          onSubmit={async () => {
            await request('POST', `/organisations/${me.organisationId}/identity-providers`, {
              name: form.name.trim(),
              issuer: form.issuer.trim(),
              clientId: form.clientId.trim(),
              ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
              forStaff: form.forStaff,
              forCandidates: form.forCandidates,
              createCandidates: form.createCandidates,
              trustMfa: form.trustMfa,
            });
            setAdding(false);
            await list.reload();
          }}
        >
          <div className="grid2">
            <Field label="Button text" hint="Shown as Sign in with …">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="University account" />
            </Field>
            <Field label="Issuer address" hint="For example https://login.microsoftonline.com/your-tenant-id/v2.0">
              <input type="url" value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} required />
            </Field>
            <Field label="Client ID">
              <input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required />
            </Field>
            <Field label="Client secret" hint="Stored encrypted and never shown again.">
              <input type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} autoComplete="off" />
            </Field>
          </div>
          <Check label="Staff may sign in with it" checked={form.forStaff} onChange={(v) => setForm({ ...form, forStaff: v })} />
          <Check label="Candidates may sign in with it" checked={form.forCandidates} onChange={(v) => setForm({ ...form, forCandidates: v })} />
          <Check
            label="Register candidates it vouches for who are not yet on the list"
            checked={form.createCandidates}
            onChange={(v) => setForm({ ...form, createCandidates: v })}
            hint="They wait for approval like anyone who registers."
          />
          <Check
            label="Trust its own two factor sign in"
            checked={form.trustMfa}
            onChange={(v) => setForm({ ...form, trustMfa: v })}
            hint="When your organisation requires two factor sign in for staff, those signing in through this provider are not asked for an ExamGuard code as well."
          />
        </Form>
      ) : (
        <button onClick={() => setAdding(true)}>Add an identity provider</button>
      )}
    </>
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
