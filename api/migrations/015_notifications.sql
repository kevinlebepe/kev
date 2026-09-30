-- Reminders and alerts (spec section 20). Each is sent once: these record
-- when, so a restart or a second API instance never sends it again.

ALTER TABLE exam_assignments
  ADD COLUMN precheck_reminded_at timestamptz,
  ADD COLUMN start_reminded_at timestamptz;

ALTER TABLE sessions ADD COLUMN invigilators_reminded_at timestamptz;

ALTER TABLE submissions ADD COLUMN evidence_alerted_at timestamptz;

-- In app notifications are listed newest first for each person.
CREATE INDEX notifications_in_app_by_user ON notifications (recipient_user_id, created_at DESC) WHERE channel = 'in_app';
