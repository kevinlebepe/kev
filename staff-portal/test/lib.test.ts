import { describe, expect, it } from 'vitest';
import { describeDetails } from '../src/lib/api';
import { connected, formatDuration, isoToLocal, label, parseCandidateCsv } from '../src/lib/format';
import { parseHash } from '../src/lib/router';
import { withDefaults } from '../src/pages/Exams';
import { presence } from '../src/pages/Live';

describe('candidate CSV', () => {
  it('reads lines, skips a header and blank lines, and handles quotes', () => {
    const text = 'Email,Full name,Student number\n\nthandi@example.ac.za, Thandi Mokoena ,2024001\n"sipho@example.ac.za","Dlamini, Sipho",,"BCom ""Hons"""\nbad-line-without-name';
    expect(parseCandidateCsv(text)).toEqual([
      { email: 'thandi@example.ac.za', fullName: 'Thandi Mokoena', studentId: '2024001' },
      { email: 'sipho@example.ac.za', fullName: 'Dlamini, Sipho', programme: 'BCom "Hons"' },
    ]);
  });
});

describe('formatting', () => {
  it('formats durations and never shows negative time', () => {
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-5000)).toBe('0:00');
  });
  it('turns keys into words', () => {
    expect(label('pending_approval')).toBe('Pending approval');
    expect(label(null)).toBe('');
  });
  it('fills a datetime-local input', () => {
    expect(isoToLocal(new Date(2030, 0, 2, 9, 5))).toBe('2030-01-02T09:05');
  });
});

describe('routing', () => {
  it('splits the hash into parts', () => {
    expect(parseHash('')).toEqual([]);
    expect(parseHash('#/')).toEqual([]);
    expect(parseHash('#/sessions/abc/results')).toEqual(['sessions', 'abc', 'results']);
    expect(parseHash('#/live/a%20b?x=1')).toEqual(['live', 'a b']);
  });
});

describe('server errors', () => {
  it('reads validation details from the API', () => {
    expect(describeDetails(['Duration is required'])).toBe('Duration is required');
    expect(describeDetails({ errors: [], properties: { email: { errors: ['Invalid email'] } } })).toBe('email: Invalid email');
    expect(describeDetails(undefined)).toBe('');
  });
});

describe('exam settings', () => {
  it('keeps stored values and fills the rest with the server defaults', () => {
    const c = withDefaults({ timing: { durationMinutes: 45 } } as never);
    expect(c.timing).toEqual({ durationMinutes: 45, startWindowMinutes: 15, lateEntryMinutes: 0, autoSubmit: true });
    expect(c.security.violationPolicy).toBe('flag');
    expect(c.device.supportedOs).toEqual(['windows', 'macos']);
  });
});

describe('live presence', () => {
  const base = { attemptStatus: null, entitlementStatus: 'assigned', online: false, submittedBy: null } as never as Parameters<typeof presence>[0];
  it('describes each state in a word', () => {
    expect(presence(base).text).toBe('Not started');
    expect(presence({ ...base, entitlementStatus: 'precheck_complete' }).text).toBe('Ready to start');
    expect(presence({ ...base, attemptStatus: 'active', online: true })).toEqual({ text: 'Writing', tone: 'ok' });
    expect(presence({ ...base, attemptStatus: 'active', online: false })).toEqual({ text: 'Not responding', tone: 'bad' });
    expect(presence({ ...base, attemptStatus: 'submitted', submittedBy: 'candidate' }).text).toBe('Submitted');
    expect(presence({ ...base, attemptStatus: 'submitted', submittedBy: 'system' }).text).toBe('Ended early');
  });
});

describe('invigilator presence', () => {
  it('counts an invigilator as connected for 2 minutes after the console last checked in', () => {
    const now = Date.parse('2030-01-01T10:00:00Z');
    expect(connected('2030-01-01T09:59:00Z', now)).toBe(true);
    expect(connected('2030-01-01T09:57:00Z', now)).toBe(false);
    expect(connected(null, now)).toBe(false);
  });
});
