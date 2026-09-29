-- Invigilator actions, candidate presence, human marking and results release
-- (spec sections 7, 8 and 6 "Results").

-- The candidate app checks in while an exam is open; the live console shows
-- a candidate as online when the last check in is recent.
ALTER TABLE attempts ADD COLUMN last_seen_at timestamptz;

-- Messages and warnings from an invigilator to a candidate during an attempt.
CREATE TABLE attempt_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  attempt_id      uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  sender_user_id  uuid REFERENCES users(id),
  kind            text NOT NULL CHECK (kind IN ('message', 'warning')),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  seq             bigserial,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);
CREATE INDEX attempt_messages_attempt ON attempt_messages (attempt_id, seq);

-- One human mark per free text question. Automatic marks are recomputed from
-- the answer key, so only the human part is stored.
CREATE TABLE manual_marks (
  attempt_id     uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id    uuid NOT NULL REFERENCES questions(id),
  points         numeric(10,2) NOT NULL CHECK (points >= 0),
  comment        text,
  marked_by      uuid NOT NULL REFERENCES users(id),
  marked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, question_id)
);

ALTER TABLE results
  ADD COLUMN marked_at    timestamptz,
  ADD COLUMN released_by  uuid REFERENCES users(id);

INSERT INTO permissions (key, description) VALUES ('result:mark', 'Mark free text answers');
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'result:mark' FROM roles r
 WHERE r.organisation_id IS NULL AND r.key IN ('owner', 'admin', 'exam_manager', 'reviewer');
