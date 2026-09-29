import { z } from 'zod';
import type { ExamConfig } from './examConfig.js';

// What the candidate application reports after running its device check
// (spec section 10). The server decides pass or fail; the client only reports.
export const readinessReport = z.object({
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  os: z.object({ platform: z.enum(['windows', 'macos', 'linux', 'chromeos', 'other']), version: z.string().max(100) }),
  camera: z.object({ detected: z.boolean() }),
  microphone: z.object({ detected: z.boolean() }),
  screenCapture: z.object({ ready: z.boolean() }),
  storage: z.object({ freeMb: z.number().min(0) }),
  displays: z.object({ count: z.number().int().min(0).max(16) }),
  virtualMachine: z.object({ detected: z.boolean() }),
  network: z.object({ tested: z.boolean(), latencyMs: z.number().min(0).optional() }),
  clientTime: z.iso.datetime({ offset: true }),
});

export type ReadinessReport = z.infer<typeof readinessReport>;

export interface ReadinessCheck {
  key: string;
  passed: boolean;
  message: string;
}

/** Maximum tolerated difference between the device clock and server time. */
export const MAX_CLOCK_DRIFT_SECONDS = 120;

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function evaluateReadiness(
  config: ExamConfig,
  report: ReadinessReport,
  context: { identityVerified: boolean; serverTime: Date },
): { passed: boolean; checks: ReadinessCheck[] } {
  const checks: ReadinessCheck[] = [];
  const check = (key: string, passed: boolean, ok: string, fail: string) =>
    checks.push({ key, passed, message: passed ? ok : fail });

  const { device, security, offline } = config;

  check('identity', context.identityVerified, 'Identity verified', 'Identity has not been verified');

  check(
    'app_version',
    !device.minAppVersion || compareVersions(report.appVersion, device.minAppVersion) >= 0,
    'Application version accepted',
    `Update the application to version ${device.minAppVersion} or later`,
  );

  check(
    'os',
    (device.supportedOs as string[]).includes(report.os.platform),
    'Operating system supported',
    `This exam supports: ${device.supportedOs.join(', ')}`,
  );

  if (security.camera) check('camera', report.camera.detected, 'Camera detected', 'No camera detected');
  if (security.microphone) check('microphone', report.microphone.detected, 'Microphone detected', 'No microphone detected');
  if (security.screenCapture)
    check('screen_capture', report.screenCapture.ready, 'Screen capture ready', 'Screen capture permission is not granted');

  check(
    'storage',
    report.storage.freeMb >= device.minFreeStorageMb,
    'Storage available',
    `At least ${device.minFreeStorageMb} MB of free storage is required`,
  );

  check(
    'displays',
    device.allowExternalMonitors || report.displays.count <= 1,
    'Display configuration accepted',
    'Disconnect external monitors',
  );

  check(
    'virtual_machine',
    device.allowVirtualMachines || !report.virtualMachine.detected,
    'No virtual machine detected',
    'This exam cannot be taken inside a virtual machine',
  );

  const driftSeconds = Math.abs(new Date(report.clientTime).getTime() - context.serverTime.getTime()) / 1000;
  check(
    'clock',
    driftSeconds <= MAX_CLOCK_DRIFT_SECONDS,
    'System clock synchronised',
    `System clock is ${Math.round(driftSeconds)} seconds out; synchronise it and retry`,
  );

  // Offline-capable exams may proceed without a network test (spec section 4).
  check(
    'network',
    report.network.tested || offline.allowed,
    'Network test complete',
    'Network test did not complete',
  );

  return { passed: checks.every((c) => c.passed), checks };
}
