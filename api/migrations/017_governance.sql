-- Privacy and governance (spec sections 2, 19 and 23).

-- The organisation's own notice to candidates about monitoring and data,
-- shown before the exam; the candidate's agreement is recorded with a hash
-- of the exact text.
ALTER TABLE organisations ADD COLUMN candidate_notice text CHECK (length(candidate_notice) <= 5000);

-- A hold keeps an attempt's recordings and files past the retention period,
-- for an appeal or an investigation, and blocks erasure until it is lifted.
ALTER TABLE attempts
  ADD COLUMN hold_reason text,
  ADD COLUMN held_by uuid REFERENCES users(id),
  ADD COLUMN held_at timestamptz;

-- Erasure keeps the row, so results statistics and the audit trail still
-- add up, but removes what identifies the person.
ALTER TABLE candidates ADD COLUMN erased_at timestamptz;
ALTER TABLE attempt_files ADD COLUMN deleted_at timestamptz;

-- Support cases (spec section 23): raised by a candidate, and handled by the
-- organisation or, for platform problems, by platform support.
ALTER TABLE support_cases
  ADD COLUMN raised_by uuid REFERENCES users(id),
  ADD COLUMN assignment_id uuid REFERENCES exam_assignments(id),
  ADD COLUMN category text NOT NULL DEFAULT 'other'
    CHECK (category IN ('sign_in', 'device_check', 'exam_access', 'accommodation', 'during_exam', 'results', 'other')),
  ADD COLUMN details text CHECK (length(details) <= 5000),
  ADD COLUMN reply text CHECK (length(reply) <= 5000),
  ADD COLUMN replied_by uuid REFERENCES users(id),
  ADD COLUMN replied_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX support_cases_org ON support_cases (organisation_id, status, created_at DESC);

INSERT INTO permissions (key, description) VALUES ('support:manage', 'Handle support cases');
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'support:manage' FROM roles r WHERE r.organisation_id IS NULL AND r.key IN ('owner', 'admin', 'support');

-- A support agent handles cases and sees the candidate behind each case, but
-- no longer browses every candidate record (spec section 2).
DELETE FROM role_permissions rp USING roles r
 WHERE rp.role_id = r.id AND r.organisation_id IS NULL AND r.key = 'support' AND rp.permission_key = 'candidate:view';
