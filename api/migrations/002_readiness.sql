-- Pre-exam readiness (spec sections 4 and 10). Every check run is kept so the
-- organisation can see failures before the assessment starts.

CREATE TABLE readiness_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  assignment_id   uuid NOT NULL REFERENCES exam_assignments(id) ON DELETE CASCADE,
  passed          boolean NOT NULL,
  checks          jsonb NOT NULL,
  report          jsonb NOT NULL,
  client_ip       inet,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX readiness_checks_assignment_time ON readiness_checks (assignment_id, created_at DESC);

-- Latest result, denormalised for fast session readiness views.
ALTER TABLE exam_assignments
  ADD COLUMN last_check_id uuid REFERENCES readiness_checks(id),
  DROP COLUMN precheck;
