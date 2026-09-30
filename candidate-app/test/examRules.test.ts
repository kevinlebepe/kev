import { describe, expect, it } from 'vitest';
import { consequenceText, noticeText, rulesFrom } from '../src/lib/examRules';
import type { ExamManifest } from '../src/lib/types';

const manifest = (security: object) => ({ config: { security } }) as unknown as ExamManifest;

describe('exam rules from the package', () => {
  it('reads what the organisation published', () => {
    expect(rulesFrom(manifest({ fullscreen: false, blockClipboard: false, violationPolicy: 'submit_immediately', maxViolations: 1 }))).toEqual({
      fullscreen: false,
      blockClipboard: false,
      policy: 'submit_immediately',
      maxViolations: 1,
    });
  });

  it('falls back to the strict defaults for packages that predate rules', () => {
    expect(rulesFrom(manifest({ kiosk: true }))).toEqual({ fullscreen: true, blockClipboard: true, policy: 'flag', maxViolations: 3 });
  });

  it('states the consequence for each policy', () => {
    const base = { fullscreen: true, blockClipboard: true, maxViolations: 3 };
    expect(consequenceText({ ...base, policy: 'flag' })).toMatch(/recorded and reviewed/);
    expect(consequenceText({ ...base, policy: 'warn_then_submit' })).toMatch(/more than 3 times/);
    expect(consequenceText({ ...base, maxViolations: 1, policy: 'warn_then_submit' })).toMatch(/more than 1 time,/);
    expect(consequenceText({ ...base, policy: 'submit_immediately' })).toMatch(/submitted immediately/);
  });

  it('tells the candidate how many warnings are left, and when it is final', () => {
    expect(noticeText({ action: 'warned', violations: 1, maxViolations: 3 })).toMatch(/left the exam 1 time\. You can leave it 2 more times/);
    expect(noticeText({ action: 'warned', violations: 2, maxViolations: 3 })).toMatch(/1 more time before/);
    expect(noticeText({ action: 'warned', violations: 3, maxViolations: 3 })).toMatch(/^Final warning/);
    expect(noticeText({ action: 'recorded', violations: 4, maxViolations: 3 })).toMatch(/recorded/);
    expect(noticeText({ action: 'none', violations: 0, maxViolations: 3 })).toBeNull();
  });
});
