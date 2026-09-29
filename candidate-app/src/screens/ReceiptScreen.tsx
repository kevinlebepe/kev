import { useState } from 'react';
import type { Receipt } from '../lib/types';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

/** Where the recording upload stands after the exam closes. */
export type UploadState = 'none' | 'uploading' | 'done' | 'incomplete';

/** Why the exam ended early, when the app knows. */
export type EndedBy = 'rules' | 'invigilator' | null;

const ENDED_TEXT: Record<'rules' | 'invigilator' | 'unknown', string> = {
  rules: '⛔ Your exam was ended because the exam rules were not followed. Your saved answers were submitted, and your organisation will review this.',
  invigilator: '⛔ Your invigilator ended your exam. Your saved answers were submitted. Contact your organisation if you think this was a mistake.',
  unknown: '⛔ Your exam was ended early. Your saved answers were submitted, and your organisation will review this.',
};

export function ReceiptScreen({
  examName,
  receipt,
  endedBy = null,
  upload = 'none',
  uploadPending = 0,
  onExit,
}: {
  examName: string;
  receipt: Receipt;
  endedBy?: EndedBy;
  upload?: UploadState;
  uploadPending?: number;
  onExit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timedOut = receipt.submittedBy === 'timer';
  const endedEarly = receipt.submittedBy === 'system';

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
        <p className={`banner ${endedEarly ? 'bad' : timedOut ? 'warn' : 'ok'}`} role="status">
          {endedEarly
            ? ENDED_TEXT[endedBy ?? 'unknown']
            : timedOut
              ? '⚠ Time ran out, so your saved answers were submitted automatically.'
              : '✓ Your answers were received. You can close this window.'}
        </p>

        {upload === 'uploading' && (
          <p className="banner warn" role="status" aria-live="polite">
            ↻ Sending the last of your exam recording{uploadPending ? ` (${uploadPending} part${uploadPending === 1 ? '' : 's'} left)` : ''}. Keep this window open until
            this finishes.
          </p>
        )}
        {upload === 'done' && (
          <p className="banner ok" role="status">
            ✓ Your exam recording has been sent.
          </p>
        )}
        {upload === 'incomplete' && (
          <p className="banner bad" role="alert">
            ⚠ Part of your exam recording could not be sent. Your answers are safe. Tell your organisation’s exam support.
          </p>
        )}

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
          Keep the receipt number. When your organisation releases the results, they appear under My results.
        </p>

        <div className="row">
          <button onClick={copy}>{copied ? '✓ Copied' : 'Copy receipt'}</button>
          <button className="primary" onClick={onExit} disabled={upload === 'uploading'}>
            Back to my exams
          </button>
        </div>
      </section>
    </main>
  );
}
