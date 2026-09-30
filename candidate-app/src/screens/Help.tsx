import { useEffect, useState } from 'react';
import { fetchBlob, request } from '../lib/api';
import type { Entitlement } from '../lib/types';

// Help and support (spec section 23). A candidate asks their organisation
// about exam rules, eligibility or accommodations, or reports a problem with
// signing in, the device check or the exam app, which platform support can see.

interface SupportCase {
  id: string;
  category: string;
  scope: 'organisation' | 'platform';
  status: 'open' | 'in_progress' | 'resolved';
  summary: string;
  details: string | null;
  reply: string | null;
  createdAt: string;
  repliedAt: string | null;
}

export const CATEGORY_TEXT: Record<string, string> = {
  device_check: 'The device check',
  sign_in: 'Signing in',
  during_exam: 'A problem during an exam',
  exam_access: 'Access to an exam',
  accommodation: 'An accommodation, such as extra time',
  results: 'Results',
  other: 'Something else',
};

const STATUS_TEXT = { open: 'Sent', in_progress: 'Being looked at', resolved: 'Answered' };

export function Help({
  items,
  preset,
  onBack,
}: {
  items: Entitlement[];
  preset?: { category?: string; entitlementId?: string };
  onBack: () => void;
}) {
  const [cases, setCases] = useState<SupportCase[] | null>(null);
  const [category, setCategory] = useState(preset?.category ?? 'other');
  const [entitlementId, setEntitlementId] = useState(preset?.entitlementId ?? '');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const load = () =>
    request<{ items: SupportCase[] }>('GET', '/me/support')
      .then((d) => setCases(d.items))
      .catch((err) => setError((err as Error).message));
  useEffect(() => void load(), []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const created = await request<{ scope: 'organisation' | 'platform' }>('POST', '/me/support', {
        category,
        summary: summary.trim(),
        ...(details.trim() ? { details: details.trim() } : {}),
        ...(entitlementId ? { entitlementId } : {}),
      });
      setSent(
        created.scope === 'platform'
          ? 'Sent. Your organisation and ExamGuard support can both see it. The reply comes by email and appears here.'
          : 'Sent to your organisation. The reply comes by email and appears here.',
      );
      setSummary('');
      setDetails('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="help-title">
      <button className="link" onClick={onBack}>
        ‹ Back to my exams
      </button>
      <h1 id="help-title">Help</h1>
      <p className="help">
        Questions about exam rules, whether you may sit an exam, or accommodations go to your organisation. Problems signing in, with the device check or with the exam app
        are also shown to ExamGuard support. If you cannot reach this page, check the <a href="/status">system status</a>.
      </p>

      <form className="stack" onSubmit={send}>
        <label>
          What is it about?
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(CATEGORY_TEXT).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {items.length > 0 && (
          <label>
            Which exam? (optional)
            <select value={entitlementId} onChange={(e) => setEntitlementId(e.target.value)}>
              <option value="">Not about one exam</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.examName}, {i.sessionName}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          In one line
          <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={200} required minLength={3} />
        </label>
        <label>
          More detail (optional)
          <textarea rows={4} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={5000} />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {sent && (
          <p className="banner ok" role="status">
            {sent}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>

      <h2>Your requests</h2>
      {cases === null ? (
        <p className="help">Loading…</p>
      ) : cases.length === 0 ? (
        <p className="help">None yet.</p>
      ) : (
        <ul className="cases">
          {cases.map((c) => (
            <li key={c.id}>
              <strong>{c.summary}</strong> <span className="help">({CATEGORY_TEXT[c.category] ?? c.category}, {STATUS_TEXT[c.status]})</span>
              {c.reply && (
                <blockquote>
                  <span className="help">Reply:</span> {c.reply}
                </blockquote>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2>Your data</h2>
      <p className="help">You can download a copy of everything your organisation holds about you in ExamGuard: your details, exams, device checks, answers and released results.</p>
      <button
        onClick={async () => {
          try {
            const url = URL.createObjectURL(await fetchBlob('/me/export'));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'my-examguard-data.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        Download my data
      </button>
    </section>
  );
}
