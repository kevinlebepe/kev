-- Exam attempts (spec sections 9, 11 and 16). The server owns the deadline:
-- the candidate app only displays it.

ALTER TABLE attempts
  ADD COLUMN deadline_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN submitted_by text CHECK (submitted_by IN ('candidate', 'timer', 'system'));
ALTER TABLE attempts ALTER COLUMN deadline_at DROP DEFAULT;

-- One attempt per entitlement; a retake is a new assignment.
CREATE UNIQUE INDEX attempts_one_per_assignment ON attempts (assignment_id);

-- Lets the expiry sweeper find overdue attempts without scanning everything.
CREATE INDEX attempts_active_deadline ON attempts (deadline_at) WHERE status = 'active';

ALTER TABLE submissions
  ADD COLUMN answered          integer NOT NULL DEFAULT 0,
  ADD COLUMN total             integer NOT NULL DEFAULT 0,
  ADD COLUMN receipt_signature text;
