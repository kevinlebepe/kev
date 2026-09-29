// Exam rules (spec sections 8, 9 and 18). The candidate app reports what it
// sees; the server keeps the count and decides, so a modified app cannot
// hide a violation or skip its consequence.

export const RULE_EVENT_TYPES = [
  'left_fullscreen',
  'returned_fullscreen',
  'left_window',
  'returned_window',
  'copy_attempt',
  'cut_attempt',
  'paste_attempt',
  'context_menu',
  'shortcut_blocked',
  'close_attempt',
  'display_added',
] as const;

export type RuleEventType = (typeof RULE_EVENT_TYPES)[number];

interface RuleEventInfo {
  severity: 'info' | 'warning' | 'high';
  /** Counts towards the exam's violation policy. */
  counts: boolean;
}

// Leaving the exam, or adding another screen, counts. Blocked clipboard and shortcut attempts are
// recorded for review but do not count: an accidental Ctrl+C should not end
// someone's exam, and the action itself was already prevented.
export const RULE_EVENTS: Record<RuleEventType, RuleEventInfo> = {
  left_fullscreen: { severity: 'high', counts: true },
  returned_fullscreen: { severity: 'info', counts: false },
  left_window: { severity: 'high', counts: true },
  returned_window: { severity: 'info', counts: false },
  close_attempt: { severity: 'high', counts: true },
  // Plugging in another screen during the exam (desktop application only).
  display_added: { severity: 'high', counts: true },
  copy_attempt: { severity: 'warning', counts: false },
  cut_attempt: { severity: 'warning', counts: false },
  paste_attempt: { severity: 'warning', counts: false },
  context_menu: { severity: 'info', counts: false },
  shortcut_blocked: { severity: 'warning', counts: false },
};

export const COUNTED_EVENT_TYPES = RULE_EVENT_TYPES.filter((t) => RULE_EVENTS[t].counts);

export type ViolationPolicy = 'flag' | 'warn_then_submit' | 'submit_immediately';
export type RuleAction = 'none' | 'recorded' | 'warned' | 'ended';

export function decideAction(policy: ViolationPolicy, maxViolations: number, violations: number): RuleAction {
  if (violations === 0) return 'none';
  switch (policy) {
    case 'submit_immediately':
      return 'ended';
    case 'warn_then_submit':
      return violations > maxViolations ? 'ended' : 'warned';
    default:
      return 'recorded';
  }
}
