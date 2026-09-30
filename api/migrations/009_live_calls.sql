-- Live video and voice between an invigilator and a candidate (spec sections
-- 8 and 13, MVP 6 and 7). The media goes directly between the two browsers
-- over WebRTC; the API only passes the connection messages.

CREATE TABLE live_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  attempt_id      uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  started_by      uuid NOT NULL REFERENCES users(id),
  -- With voice the invigilator can speak to the candidate; without it they only watch.
  voice           boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ended')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
CREATE UNIQUE INDEX live_calls_one_open ON live_calls (attempt_id) WHERE status = 'open';

CREATE TABLE live_signals (
  id         bigserial PRIMARY KEY,
  call_id    uuid NOT NULL REFERENCES live_calls(id) ON DELETE CASCADE,
  sender     text NOT NULL CHECK (sender IN ('staff', 'candidate')),
  type       text NOT NULL CHECK (type IN ('offer', 'answer', 'ice')),
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_signals_call ON live_signals (call_id, id);
