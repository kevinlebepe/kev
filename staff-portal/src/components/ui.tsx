import { type ReactNode, useState } from 'react';
import { label } from '../lib/format';

export function Page({ title, back, actions, children }: { title: string; back?: { href: string; text: string }; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="page">
      {back && (
        <p className="back">
          <a href={back.href}>‹ {back.text}</a>
        </p>
      )}
      <header className="page-head">
        <h1>{title}</h1>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {error}
    </p>
  );
}

export function Loading({ loading, empty, children }: { loading: boolean; empty?: string | false; children: ReactNode }) {
  if (loading) return <p className="muted">Loading…</p>;
  if (empty) return <p className="muted">{empty}</p>;
  return <>{children}</>;
}

const TONES: Record<string, string> = {
  approved: 'ok',
  active: 'ok',
  open: 'ok',
  published: 'ok',
  released: 'ok',
  marked: 'ok',
  moderated: 'ok',
  monitoring: 'ok',
  precheck_complete: 'ok',
  submitted: 'info',
  completed: 'info',
  scheduled: 'info',
  available: 'info',
  pending: 'warn',
  pending_approval: 'warn',
  invited: 'warn',
  registered: 'warn',
  assigned: 'warn',
  draft: 'warn',
  paused: 'warn',
  full: 'warn',
  closed: 'muted',
  archived: 'muted',
  cancelled: 'muted',
  offline: 'muted',
  rejected: 'bad',
  blocked: 'bad',
  suspended: 'bad',
  revoked: 'bad',
};

export function Badge({ value, tone }: { value: string | null | undefined; tone?: string }) {
  if (!value) return null;
  return <span className={`badge ${tone ?? TONES[value] ?? 'muted'}`}>{label(value)}</span>;
}

/** A button that runs an async action, shows progress and reports a failure next to itself. */
export function ActionButton({
  onClick,
  children,
  className,
  confirm,
  disabled,
}: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  className?: string;
  confirm?: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="action">
      <button
        className={className}
        disabled={busy || disabled}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setError(null);
          try {
            await onClick();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Working…' : children}
      </button>
      {error && (
        <span className="error inline" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** A form whose submit runs an async action; errors are shown under it. */
export function Form({
  onSubmit,
  submitText,
  children,
  onCancel,
}: {
  onSubmit: () => Promise<unknown>;
  submitText: string;
  children: ReactNode;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      <ErrorText error={error} />
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Working…' : submitText}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function Field({ label: text, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{text}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function Check({ label: text, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {text}
        {hint && <small className="muted"> {hint}</small>}
      </span>
    </label>
  );
}

export function Stat({ label: text, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{text}</span>
    </div>
  );
}
