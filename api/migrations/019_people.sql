-- People (spec sections 3, 5 and 7): candidate groups for assigning many at
-- once, exam access codes as a controlled fallback for signing in, and the
-- organisation's own branding.

CREATE TABLE candidate_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX candidate_groups_org_name ON candidate_groups (organisation_id, lower(name));

CREATE TABLE candidate_group_members (
  group_id     uuid NOT NULL REFERENCES candidate_groups(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, candidate_id)
);

-- An access code signs one approved, verified candidate in for one exam, only
-- around that exam's time. Only its hash is kept.
ALTER TABLE organisations ADD COLUMN allow_access_codes boolean NOT NULL DEFAULT false;
ALTER TABLE exam_assignments
  ADD COLUMN access_code_hash text UNIQUE,
  ADD COLUMN access_code_issued_at timestamptz;

-- Branding shown to candidates: a colour, and a small logo kept in storage.
ALTER TABLE organisations
  ADD COLUMN brand_colour text CHECK (brand_colour ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN logo_key text,
  ADD COLUMN logo_type text;

-- A session started with an access code ends with the exam: refreshing
-- never carries it past this time.
ALTER TABLE refresh_tokens ADD COLUMN hard_expires_at timestamptz;
