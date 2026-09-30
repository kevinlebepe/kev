-- Exam settings that change how an attempt, a session and its results behave:
-- a per attempt question order when the exam shuffles questions, and when a
-- session's invigilators last rotated. Moderation records who confirmed the
-- marks of a result before it could be released.

ALTER TABLE attempts ADD COLUMN question_order uuid[];

ALTER TABLE sessions ADD COLUMN last_rotated_at timestamptz;

ALTER TABLE results
  ADD COLUMN moderated_by uuid REFERENCES users(id),
  ADD COLUMN moderated_at timestamptz;
