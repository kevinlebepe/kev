-- Standing extra time for a candidate (an accommodation, spec section 23),
-- and files attached to file upload questions.

ALTER TABLE exam_assignments
  ADD COLUMN extra_minutes integer NOT NULL DEFAULT 0 CHECK (extra_minutes BETWEEN 0 AND 600);

CREATE TABLE attempt_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id   uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id  uuid NOT NULL REFERENCES questions(id),
  storage_key  text NOT NULL,
  file_name    text NOT NULL,
  content_type text NOT NULL,
  size_bytes   integer NOT NULL,
  sha256       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attempt_files_attempt ON attempt_files (attempt_id, question_id);
