import type { ExamManifest, ViolationPolicy } from './types';

export interface ExamRules {
  fullscreen: boolean;
  blockClipboard: boolean;
  policy: ViolationPolicy;
  maxViolations: number;
}

/** Reads the rules from the signed package. Packages published before rules existed get the strict defaults. */
export function rulesFrom(manifest: ExamManifest): ExamRules {
  const s = manifest.config.security;
  return {
    fullscreen: s.fullscreen ?? true,
    blockClipboard: s.blockClipboard ?? true,
    policy: s.violationPolicy ?? 'flag',
    maxViolations: s.maxViolations ?? 3,
  };
}

/** The consequence of leaving the exam, in words the candidate can act on. */
export function consequenceText(rules: ExamRules): string {
  switch (rules.policy) {
    case 'submit_immediately':
      return 'If you leave the exam or try to close it, your exam is submitted immediately and you cannot continue.';
    case 'warn_then_submit':
      return `You are warned each time you leave the exam. If you leave it more than ${rules.maxViolations} ${rules.maxViolations === 1 ? 'time' : 'times'}, your exam is submitted automatically.`;
    default:
      return 'Each time you leave the exam is recorded and reviewed by your organisation.';
  }
}

/** What to tell the candidate after the server counted a violation. Null means say nothing. */
export function noticeText(reply: { action: string; violations: number; maxViolations: number }): string | null {
  switch (reply.action) {
    case 'warned': {
      const left = reply.maxViolations - reply.violations;
      return left <= 0
        ? `Final warning: you have left the exam ${reply.violations} ${reply.violations === 1 ? 'time' : 'times'}. Leaving again submits your exam.`
        : `Warning: you have left the exam ${reply.violations} ${reply.violations === 1 ? 'time' : 'times'}. You can leave it ${left} more ${left === 1 ? 'time' : 'times'} before your exam is submitted.`;
    }
    case 'recorded':
      return 'You left the exam. This has been recorded and will be reviewed by your organisation.';
    default:
      return null;
  }
}
