// Organisation-level candidate lifecycle (spec section 4). Account existence,
// organisation approval and exam entitlement are deliberately separate:
// approval here never grants an exam by itself.

export type CandidateStatus = 'invited' | 'registered' | 'pending_approval' | 'approved' | 'rejected' | 'blocked';
export type IdentityStatus = 'unverified' | 'email_pending' | 'verified' | 'manual_review';
export type CandidateAction = 'approve' | 'reject' | 'block' | 'unblock';

interface Transition {
  from: readonly CandidateStatus[];
  to: CandidateStatus;
  /** Identity states from which the action is allowed. */
  identity?: readonly IdentityStatus[];
}

const TRANSITIONS: Record<CandidateAction, Transition> = {
  // Email must be proven (or the organisation must be reviewing manually) before approval.
  approve: { from: ['pending_approval'], to: 'approved', identity: ['verified', 'manual_review'] },
  reject: { from: ['invited', 'registered', 'pending_approval'], to: 'rejected' },
  block: { from: ['invited', 'registered', 'pending_approval', 'approved', 'rejected'], to: 'blocked' },
  // Unblocking sends the candidate back through review rather than straight to approved.
  unblock: { from: ['blocked'], to: 'pending_approval' },
};

export type TransitionResult = { ok: true; to: CandidateStatus } | { ok: false; reason: string };

export function transition(
  action: CandidateAction,
  current: { status: CandidateStatus; identityStatus: IdentityStatus },
): TransitionResult {
  const t = TRANSITIONS[action];
  if (!t.from.includes(current.status)) {
    return { ok: false, reason: `Cannot ${action} a candidate who is ${current.status}` };
  }
  if (t.identity && !t.identity.includes(current.identityStatus)) {
    return { ok: false, reason: `Cannot ${action} while identity is ${current.identityStatus}` };
  }
  return { ok: true, to: t.to };
}

/** Where a self-registering candidate lands, based on the organisation's approved domains. */
export function selfRegistrationOutcome(
  email: string,
  approvedDomains: readonly string[],
): { status: CandidateStatus; identityStatus: IdentityStatus } {
  const domain = email.split('@').pop()!.toLowerCase();
  const approved = approvedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
  // Approved domain: prove mailbox ownership first. Otherwise route to the
  // organisation's manual verification/approval process (spec section 3).
  return approved
    ? { status: 'registered', identityStatus: 'email_pending' }
    : { status: 'pending_approval', identityStatus: 'manual_review' };
}
