import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { allocate, liveStatus } from '../src/allocation.js';
import { selfRegistrationOutcome, transition } from '../src/candidateStatus.js';
import { canonicalJson, signManifest, verifyManifest } from '../src/signing.js';
import { compareVersions, evaluateReadiness } from '../src/readiness.js';
import { examConfig } from '../src/examConfig.js';
import { markAttempt } from '../src/marking.js';
import { browserAllowedOn } from '../src/client.js';
import { COUNTED_EVENT_TYPES, decideAction, RULE_EVENT_TYPES, RULE_EVENTS } from '../src/rules.js';

describe('allocate', () => {
  const ids = (n: number, p = 'c') => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(3, '0')}`);

  it('never gives an invigilator more than 10', () => {
    const result = allocate(ids(25), [{ id: 'a', load: 0, capacity: 10 }, { id: 'b', load: 0, capacity: 10 }]);
    const counts = result.assignments.reduce<Record<string, number>>((m, a) => ({ ...m, [a.invigilatorId]: (m[a.invigilatorId] ?? 0) + 1 }), {});
    expect(counts).toEqual({ a: 10, b: 10 });
    expect(result.unassigned).toHaveLength(5);
  });

  it('counts existing load and clamps any configured capacity to 10', () => {
    const result = allocate(ids(5), [{ id: 'a', load: 8, capacity: 50 }]);
    expect(result.assignments).toHaveLength(2);
    expect(result.unassigned).toHaveLength(3);
  });

  it('balances toward the least-loaded invigilator', () => {
    const result = allocate(ids(6), [{ id: 'a', load: 4, capacity: 10 }, { id: 'b', load: 0, capacity: 10 }]);
    const toB = result.assignments.filter((a) => a.invigilatorId === 'b').length;
    expect(toB).toBe(5); // b catches up to 4, then they alternate
  });

  it('respects a lower session cap', () => {
    const result = allocate(ids(10), [{ id: 'a', load: 0, capacity: 10 }], { sessionCap: 3 });
    expect(result.assignments).toHaveLength(3);
  });

  it('queues everyone when nobody is available', () => {
    expect(allocate(ids(2), [])).toEqual({ assignments: [], unassigned: ids(2) });
  });

  it('derives live status', () => {
    expect(liveStatus('active', 0, 10)).toBe('available');
    expect(liveStatus('active', 3, 10)).toBe('monitoring');
    expect(liveStatus('active', 10, 10)).toBe('at_capacity');
    expect(liveStatus('paused', 0, 10)).toBe('paused');
  });
});

describe('candidate lifecycle', () => {
  it('only approves verified or manually reviewed candidates awaiting approval', () => {
    expect(transition('approve', { status: 'pending_approval', identityStatus: 'verified' })).toEqual({ ok: true, to: 'approved' });
    expect(transition('approve', { status: 'pending_approval', identityStatus: 'manual_review' }).ok).toBe(true);
    expect(transition('approve', { status: 'registered', identityStatus: 'email_pending' }).ok).toBe(false);
    expect(transition('approve', { status: 'invited', identityStatus: 'unverified' }).ok).toBe(false);
    expect(transition('approve', { status: 'blocked', identityStatus: 'verified' }).ok).toBe(false);
  });

  it('unblocking returns the candidate to review, not approval', () => {
    expect(transition('unblock', { status: 'blocked', identityStatus: 'verified' })).toEqual({ ok: true, to: 'pending_approval' });
  });

  it('routes unapproved email domains to manual review', () => {
    expect(selfRegistrationOutcome('s@students.uni.example', ['uni.example'])).toEqual({
      status: 'registered',
      identityStatus: 'email_pending',
    });
    expect(selfRegistrationOutcome('s@gmail.example', ['uni.example'])).toEqual({
      status: 'pending_approval',
      identityStatus: 'manual_review',
    });
    // A lookalike domain must not match.
    expect(selfRegistrationOutcome('s@evil-uni.example', ['uni.example']).identityStatus).toBe('manual_review');
  });
});

describe('manifest signing', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  it('canonicalises key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it('verifies an untouched manifest and rejects a tampered one', () => {
    const manifest = { examId: 'x', questions: [{ id: 'q1', prompt: 'Hi' }] };
    const { signature } = signManifest(manifest, privateKey);
    expect(verifyManifest({ questions: [{ prompt: 'Hi', id: 'q1' }], examId: 'x' }, signature, publicKey)).toBe(true);
    expect(verifyManifest({ ...manifest, examId: 'y' }, signature, publicKey)).toBe(false);
  });
});

describe('readiness evaluation', () => {
  const now = new Date('2026-10-14T07:00:00Z');
  const report = {
    appVersion: '1.2.0',
    os: { platform: 'windows' as const, version: '11' },
    camera: { detected: false },
    microphone: { detected: false },
    screenCapture: { ready: false },
    storage: { freeMb: 5000 },
    displays: { count: 1 },
    virtualMachine: { detected: false },
    network: { tested: false },
    clientTime: now.toISOString(),
    appKind: 'browser' as const,
    restrictedApps: [] as string[],
  };

  it('only checks devices the exam actually uses', () => {
    const result = evaluateReadiness(examConfig.parse({}), report, { identityVerified: true, serverTime: now });
    expect(result.passed).toBe(true);
    expect(result.checks.map((c) => c.key)).not.toContain('camera');
  });

  it('fails on each configured requirement', () => {
    const config = examConfig.parse({
      security: { camera: true, microphone: true, screenCapture: true },
      offline: { allowed: false },
      device: { minAppVersion: '1.10.0', supportedOs: ['macos'], minFreeStorageMb: 8000 },
    });
    const result = evaluateReadiness(
      config,
      { ...report, displays: { count: 2 }, virtualMachine: { detected: true } },
      { identityVerified: false, serverTime: now },
    );
    expect(result.checks.filter((c) => !c.passed).map((c) => c.key).sort()).toEqual(
      ['app_version', 'camera', 'displays', 'identity', 'microphone', 'network', 'os', 'screen_capture', 'storage', 'virtual_machine'],
    );
  });

  it('fails a browser for an exam that needs the desktop application, and passes the desktop app', () => {
    const config = examConfig.parse({ device: { requireDesktopApp: true } });
    const browser = evaluateReadiness(config, report, { identityVerified: true, serverTime: now });
    expect(browser.checks.find((c) => c.key === 'desktop_app')).toMatchObject({ passed: false });
    expect(browser.passed).toBe(false);
    const desktop = evaluateReadiness(config, { ...report, appKind: 'desktop' }, { identityVerified: true, serverTime: now });
    expect(desktop.checks.find((c) => c.key === 'desktop_app')).toMatchObject({ passed: true });
    expect(desktop.passed).toBe(true);
  });

  it('lets phones, tablets and Chromebooks use a browser for an exam that requires the application on computers', () => {
    const config = examConfig.parse({ device: { requireDesktopApp: true, supportedOs: ['windows', 'macos', 'linux', 'chromeos', 'android', 'ios'] } });
    for (const platform of ['ios', 'android', 'chromeos'] as const) {
      const result = evaluateReadiness(config, { ...report, os: { platform, version: '17' } }, { identityVerified: true, serverTime: now });
      expect(result.checks.find((c) => c.key === 'desktop_app'), platform).toMatchObject({ passed: true, message: 'A browser is allowed on this kind of device' });
      expect(result.passed, platform).toBe(true);
    }
  });

  it('keeps every kind of computer, and anything unrecognised, in the application', () => {
    const config = examConfig.parse({ device: { requireDesktopApp: true, supportedOs: ['windows', 'macos', 'linux', 'chromeos', 'android', 'ios'] } });
    for (const platform of ['windows', 'macos', 'linux', 'other'] as const) {
      const result = evaluateReadiness(config, { ...report, os: { platform, version: '1' } }, { identityVerified: true, serverTime: now });
      expect(result.checks.find((c) => c.key === 'desktop_app'), platform).toMatchObject({ passed: false });
    }
  });

  it('knows which platforms may use a browser', () => {
    expect(['ios', 'android', 'chromeos'].every(browserAllowedOn)).toBe(true);
    for (const p of ['windows', 'macos', 'linux', 'other', 'freebsd', '', null, undefined]) expect(browserAllowedOn(p)).toBe(false);
  });

  it('does not ask a browser about the desktop application when the exam allows browsers', () => {
    const result = evaluateReadiness(examConfig.parse({}), report, { identityVerified: true, serverTime: now });
    expect(result.checks.map((c) => c.key)).not.toContain('desktop_app');
    expect(result.checks.map((c) => c.key)).not.toContain('restricted_apps');
  });

  it('fails the desktop application while screen sharing or remote control programs are running', () => {
    const config = examConfig.parse({});
    const result = evaluateReadiness(
      config,
      { ...report, appKind: 'desktop', restrictedApps: ['TeamViewer', 'AnyDesk'] },
      { identityVerified: true, serverTime: now },
    );
    expect(result.checks.find((c) => c.key === 'restricted_apps')).toMatchObject({
      passed: false,
      message: expect.stringContaining('TeamViewer, AnyDesk'),
    });
    const clean = evaluateReadiness(config, { ...report, appKind: 'desktop' }, { identityVerified: true, serverTime: now });
    expect(clean.checks.find((c) => c.key === 'restricted_apps')).toMatchObject({ passed: true });
  });

  it('says so plainly when a virtual machine is found but the exam allows one', () => {
    const inVm = { ...report, virtualMachine: { detected: true } };
    const allowed = evaluateReadiness(examConfig.parse({ device: { allowVirtualMachines: true } }), inVm, { identityVerified: true, serverTime: now });
    expect(allowed.checks.find((c) => c.key === 'virtual_machine')).toEqual({
      key: 'virtual_machine',
      passed: true,
      message: 'Virtual machine detected (allowed for this exam)',
    });
    const refused = evaluateReadiness(examConfig.parse({}), inVm, { identityVerified: true, serverTime: now });
    expect(refused.checks.find((c) => c.key === 'virtual_machine')).toMatchObject({ passed: false, message: expect.stringContaining('cannot be taken inside') });
    const none = evaluateReadiness(examConfig.parse({}), report, { identityVerified: true, serverTime: now });
    expect(none.checks.find((c) => c.key === 'virtual_machine')).toMatchObject({ passed: true, message: 'No virtual machine detected' });
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });
});

describe('marking', () => {
  const questions = [
    { id: 'a', type: 'mcq' },
    { id: 'b', type: 'multiple_response' },
    { id: 'c', type: 'true_false' },
    { id: 'd', type: 'essay' },
  ];
  const key = {
    a: { points: 2, correctOptionIds: ['a2'] },
    b: { points: 3, correctOptionIds: ['b1', 'b2'] },
    c: { points: 1, correctOptionIds: ['c1'] },
    d: { points: 4, correctOptionIds: [] },
  };
  const mark = (answers: Record<string, object>) => markAttempt(questions, key, new Map(Object.entries(answers)));

  it('scores each automatic type and leaves free text for a human', () => {
    expect(mark({ a: { optionId: 'a2' }, b: { optionIds: ['b2', 'b1'] }, c: { optionId: 'c1' }, d: { text: 'x' } })).toMatchObject({
      score: 6,
      maxScore: 10,
      needsManual: 1,
      status: 'pending',
    });
  });

  it('adds the human mark for free text, capped at the question’s points', () => {
    const answers = new Map<string, object>([['a', { optionId: 'a2' }], ['d', { text: 'an answer' }]]);
    expect(markAttempt(questions, key, answers, new Map([['d', 3]]))).toMatchObject({ score: 5, needsManual: 0, status: 'marked' });
    expect(markAttempt(questions, key, answers, new Map([['d', 9]])).score).toBe(6);
    const d = markAttempt(questions, key, answers).questions.find((q) => q.questionId === 'd');
    expect(d).toEqual({ questionId: 'd', maxPoints: 4, awarded: null, auto: false });
  });

  it('needs no marker for a blank free text answer', () => {
    expect(mark({ d: { text: '   ' } })).toMatchObject({ needsManual: 0, status: 'marked', score: 0 });
    expect(mark({})).toMatchObject({ needsManual: 0, status: 'marked' });
  });

  it('gives no credit for wrong, partial or missing answers', () => {
    expect(mark({ a: { optionId: 'a1' }, b: { optionIds: ['b1'] } }).score).toBe(0);
    expect(mark({ b: { optionIds: ['b1', 'b2', 'b3'] } }).score).toBe(0);
    expect(mark({}).score).toBe(0);
  });

  it('is complete when every question is automatic', () => {
    const result = markAttempt([questions[0]!], key, new Map([['a', { optionId: 'a2' }]]));
    expect(result).toMatchObject({ score: 2, maxScore: 2, needsManual: 0, status: 'marked' });
  });
});

describe('exam rule decisions', () => {
  it('does nothing when there are no violations', () => {
    for (const policy of ['flag', 'warn_then_submit', 'submit_immediately'] as const) expect(decideAction(policy, 3, 0)).toBe('none');
  });

  it('only records under the flag policy, however many there are', () => {
    expect(decideAction('flag', 3, 1)).toBe('recorded');
    expect(decideAction('flag', 3, 500)).toBe('recorded');
  });

  it('warns up to the allowed number, then ends the exam', () => {
    expect(decideAction('warn_then_submit', 3, 1)).toBe('warned');
    expect(decideAction('warn_then_submit', 3, 3)).toBe('warned');
    expect(decideAction('warn_then_submit', 3, 4)).toBe('ended');
  });

  it('ends the exam at the first violation under the strictest policy', () => {
    expect(decideAction('submit_immediately', 3, 1)).toBe('ended');
  });

  it('counts leaving the exam, not blocked clipboard attempts', () => {
    expect([...COUNTED_EVENT_TYPES].sort()).toEqual(['close_attempt', 'display_added', 'left_fullscreen', 'left_window']);
    for (const type of RULE_EVENT_TYPES) expect(RULE_EVENTS[type]).toBeDefined();
  });
});
