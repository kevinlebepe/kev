-- Question pools (spec section 6): besides its fixed questions, an exam can
-- draw a number of questions at random from the question bank, by category
-- and difficulty. Every matching question is published in the signed
-- version; each candidate gets their own draw when they start.

CREATE TABLE exam_pools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id     uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  category    text,
  difficulty  text CHECK (difficulty IN ('easy', 'medium', 'hard')),
  draw_count  integer NOT NULL CHECK (draw_count BETWEEN 1 AND 200),
  points      numeric(8,2) NOT NULL DEFAULT 1 CHECK (points >= 0),
  UNIQUE (exam_id, position)
);
