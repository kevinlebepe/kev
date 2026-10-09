-- Service health (spec sections 5, 13, 17 and 21). The last known state of
-- each part of the platform, shared by every API instance, and when each
-- background job last ran, so a stalled worker shows up.

CREATE TABLE service_status (
  component   text PRIMARY KEY,
  status      text NOT NULL CHECK (status IN ('ok', 'degraded', 'down', 'off')),
  message     text,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  checked_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_runs (
  name             text PRIMARY KEY,
  interval_seconds integer NOT NULL,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_error       text,
  last_error_at    timestamptz
);
