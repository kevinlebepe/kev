import { useState } from 'react';
import { request, serverTime } from '../lib/api';
import { detectDevice } from '../lib/deviceType';
import type { Entitlement, ReadinessCheck } from '../lib/types';
import type { DeviceBridge } from '../device/bridge';

interface Result {
  passed: boolean;
  status: string;
  checks: ReadinessCheck[];
}

export function DeviceCheck({
  entitlement,
  bridge,
  onDone,
  onSupport,
}: {
  entitlement: Entitlement;
  bridge: DeviceBridge;
  onDone: () => void;
  /** Opens Help with this exam and the device check chosen. */
  onSupport?: () => void;
}) {
  const [result, setResult] = useState<Result | null>(
    entitlement.lastChecks ? { passed: !!entitlement.lastCheckPassed, status: entitlement.status, checks: entitlement.lastChecks } : null,
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const report = await bridge.collect({
        camera: entitlement.requirements.security.camera,
        microphone: entitlement.requirements.security.microphone,
        network: async () => (await serverTime()).latencyMs,
      });
      setResult(await request<Result>('POST', `/me/entitlements/${entitlement.id}/precheck`, report));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="card">
      <p className="muted">
        <button className="link" onClick={onDone}>
          ‹ My exams
        </button>
      </p>
      <h1>Device check</h1>
      <p>
        {entitlement.examName}. Run this check on the device you will use for the exam. You can run it as often as you like
        before exam day.
      </p>

      {result && (
        <>
          <p className={`banner ${result.passed ? 'ok' : 'bad'}`} role="status">
            {result.passed ? '✓ Your device is ready for this exam.' : '✕ Your device is not ready yet. Fix the items marked below and run the check again.'}
          </p>
          <ul className="checks">
            {result.checks.map((c) => (
              <li key={c.key} className={c.passed ? 'ok' : 'bad'}>
                <span aria-hidden="true">{c.passed ? '✓' : '✕'}</span>
                <span className="sr-only">{c.passed ? 'Passed:' : 'Failed:'}</span> {c.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {bridge.kind === 'browser' && (
        <p className="muted small">
          {detectDevice(navigator).kind === 'computer'
            ? `Running in a browser. These checks happen in the ExamGuard desktop application: ${bridge.limitations.join(', ')}.`
            : `Some checks, such as ${bridge.limitations.join(', ').toLowerCase()}, are not possible in a browser on this kind of device. Your organisation may lock this device down itself.`}
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="row">
        <button className="primary" onClick={run} disabled={running}>
          {running ? 'Checking…' : 'Run full test'}
        </button>
        <button onClick={onDone}>Done</button>
        {onSupport && <button onClick={onSupport}>Contact support</button>}
      </div>
      <p className="help">Something failing that you cannot fix? Contact support before exam day.</p>
    </section>
  );
}
