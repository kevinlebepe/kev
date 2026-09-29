import { useState } from 'react';
import type { Receipt } from '../lib/types';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

export function ReceiptScreen({ examName, receipt, onExit }: { examName: string; receipt: Receipt; onExit: () => void }) {
  const [copied, setCopied] = useState(false);
  const timedOut = receipt.submittedBy === 'timer';
  const endedForRules = receipt.submittedBy === 'system';

  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="centered">
      <section className="card receipt" aria-labelledby="receipt-title">
        <p className="brand">EXAMGUARD</p>
        <h1 id="receipt-title">Your exam has been submitted</h1>
        <p className={`banner ${endedForRules ? 'bad' : timedOut ? 'warn' : 'ok'}`} role="status">
          {endedForRules
            ? '⛔ Your exam was ended because the exam rules were not followed. Your saved answers were submitted, and your organisation will review this.'
            : timedOut
              ? '⚠ Time ran out, so your saved answers were submitted automatically.'
              : '✓ Your answers were received. You can close this window.'}
        </p>

        <dl className="receipt-details">
          <dt>Exam</dt>
          <dd>{examName}</dd>
          <dt>Submitted</dt>
          <dd>{dateFormat.format(new Date(receipt.submittedAt))}</dd>
          <dt>Questions answered</dt>
          <dd>
            {receipt.answered} of {receipt.total}
          </dd>
          <dt>Receipt number</dt>
          <dd className="mono">{receipt.receiptId}</dd>
          <dt>Fingerprint</dt>
          <dd className="mono">{receipt.packageSha256.slice(0, 16)}</dd>
        </dl>

        <p className="muted small">
          Keep the receipt number. Your organisation will tell you when results are released. Results are not shown here.
        </p>

        <div className="row">
          <button onClick={copy}>{copied ? '✓ Copied' : 'Copy receipt'}</button>
          <button className="primary" onClick={onExit}>
            Back to my exams
          </button>
        </div>
      </section>
    </main>
  );
}
