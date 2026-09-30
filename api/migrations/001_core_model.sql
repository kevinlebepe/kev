-- ExamGuard core data model (spec section 15).
-- Every tenant-owned row carries organisation_id so tenant isolation can be
-- enforced in every query (spec sections 1, 16, 19).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy, identity and RBAC (spec sections 1-3)
-- ---------------------------------------------------------------------------

CREATE TABLE organisations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name                   text NOT NULL,
  mode                   text NOT NULL CHECK (mode IN
                           ('university', 'school', 'employer', 'recruitment_agency', 'certification', 'other')),
  approved_email_domains text[] NOT NULL DEFAULT '{}',
  settings               jsonb NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  password_hash  text,
  display_name   text NOT NULL,
  platform_role  text CHECK (platform_role IN ('super_admin')),
  mfa_enabled    boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE permissions (
  key         text PRIMARY KEY,
  description text NOT NULL
);

-- organisation_id NULL = platform-provided role template shared by all tenants.
CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid REFERENCES organisations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_org_key ON roles (coalesce(organisation_id, '00000000-0000-0000-0000-000000000000'), key);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE organisation_users (
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id         uuid NOT NULL REFERENCES roles(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id)
);

CREATE TABLE refresh_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  replaced_by     uuid REFERENCES refresh_tokens(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Candidates, approval and entitlement (spec sections 3-4)
-- ---------------------------------------------------------------------------

-- Organisation-level candidate status. Exam-specific states (assigned,
-- pre-check complete, active, submitted, completed) live on exam_assignments
-- because one candidate can hold several entitlements.
CREATE TABLE candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id),
  email           text NOT NULL,
  full_name       text NOT NULL,
  student_id      text,
  programme       text,
  status          text NOT NULL CHECK (status IN
                    ('invited', 'registered', 'pending_approval', 'approved', 'rejected', 'blocked')),
  identity_status text NOT NULL DEFAULT 'unverified' CHECK (identity_status IN
                    ('unverified', 'email_pending', 'verified', 'manual_review')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX candidates_org_email ON candidates (organisation_id, lower(email));
CREATE UNIQUE INDEX candidates_org_user ON candidates (organisation_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX candidates_org_status ON candidates (organisation_id, status);

-- Single-use tokens for invitations and email verification. Only hashes are stored.
CREATE TABLE candidate_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  candidate_id    uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  purpose         text NOT NULL CHECK (purpose IN ('invitation', 'email_verification')),
  token_hash      text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invigilators (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  staff_id        text,
  -- Administrative status. Available / monitoring / at capacity are derived
  -- from the live assignment count (spec section 7).
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'suspended')),
  -- Hard ceiling of 10 (spec section 7); organisations may configure lower.
  max_active      integer NOT NULL DEFAULT 10 CHECK (max_active BETWEEN 1 AND 10),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Exams, versions and question bank (spec section 6)
-- ---------------------------------------------------------------------------

CREATE TABLE exams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  subject         text,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  -- Editable draft configuration: timing, security, invigilation, offline, results.
  config          jsonb NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code)
);

CREATE TABLE questions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN
                    ('mcq', 'multiple_response', 'true_false', 'short_answer', 'essay', 'file_upload')),
  prompt          text NOT NULL,
  category        text,
  difficulty      text CHECK (difficulty IN ('easy', 'medium', 'hard')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE question_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  label       text NOT NULL,
  is_correct  boolean NOT NULL DEFAULT false,
  UNIQUE (question_id, position)
);

CREATE TABLE exam_questions (
  exam_id     uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id),
  position    integer NOT NULL,
  points      numeric(8,2) NOT NULL DEFAULT 1 CHECK (points >= 0),
  PRIMARY KEY (exam_id, question_id),
  UNIQUE (exam_id, position)
);

-- Immutable published snapshots (spec section 6 "Exam publish gate").
CREATE TABLE exam_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  exam_id         uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  manifest        jsonb NOT NULL,
  -- Candidate-facing manifest: never contains correct answers.
  manifest_sha256 text NOT NULL,
  signature       text NOT NULL,
  signing_key_id  text NOT NULL,
  -- Server-side only; used for auto-marking and never sent to candidate devices.
  answer_key      jsonb NOT NULL,
  published_by    uuid REFERENCES users(id),
  published_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, version)
);

-- ---------------------------------------------------------------------------
-- Sessions, assignments and attempts (spec sections 4, 9, 11)
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  exam_version_id uuid NOT NULL REFERENCES exam_versions(id),
  name            text NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'open', 'closed', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE exam_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  candidate_id    uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'assigned' CHECK (status IN
                    ('assigned', 'precheck_complete', 'active', 'submitted', 'completed', 'revoked')),
  precheck        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, candidate_id)
);

CREATE TABLE attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  assignment_id   uuid NOT NULL REFERENCES exam_assignments(id) ON DELETE CASCADE,
  exam_version_id uuid NOT NULL REFERENCES exam_versions(id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'submitted', 'completed', 'abandoned')),
  state           jsonb NOT NULL DEFAULT '{}',
  state_seq       bigint NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  submitted_at    timestamptz
);

CREATE TABLE answers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id  uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id),
  response    jsonb NOT NULL,
  client_seq  bigint NOT NULL,
  saved_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, question_id)
);

-- ---------------------------------------------------------------------------
-- Recording and evidence (spec section 12)
-- ---------------------------------------------------------------------------

CREATE TABLE recording_streams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id  uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  stream_type text NOT NULL CHECK (stream_type IN ('screen', 'camera', 'audio')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, stream_type)
);

-- (stream_id, sequence) is unique so duplicate uploads cannot create duplicate evidence.
CREATE TABLE recording_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id       uuid NOT NULL REFERENCES recording_streams(id) ON DELETE CASCADE,
  sequence        integer NOT NULL CHECK (sequence >= 0),
  start_time      timestamptz NOT NULL,
  end_time        timestamptz NOT NULL,
  checksum        text NOT NULL,
  storage_key     text,
  upload_state    text NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending', 'uploading', 'uploaded', 'failed')),
  retention_state text NOT NULL DEFAULT 'retained' CHECK (retention_state IN ('retained', 'scheduled_deletion', 'deleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stream_id, sequence)
);

CREATE TABLE events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  attempt_id      uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  invigilator_id  uuid REFERENCES invigilators(id),
  type            text NOT NULL,
  severity        text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'high')),
  occurred_at     timestamptz NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_attempt_time ON events (attempt_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Invigilation (spec sections 7-8)
-- ---------------------------------------------------------------------------

-- Invigilators rostered onto a session; allocation only draws from this pool.
CREATE TABLE session_invigilators (
  session_id     uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  invigilator_id uuid NOT NULL REFERENCES invigilators(id) ON DELETE CASCADE,
  added_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, invigilator_id)
);

CREATE TABLE invigilation_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  invigilator_id  uuid NOT NULL REFERENCES invigilators(id),
  candidate_id    uuid NOT NULL REFERENCES candidates(id),
  active          boolean NOT NULL DEFAULT true,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  CHECK (active = (released_at IS NULL))
);
-- A candidate has at most one live invigilator per session.
CREATE UNIQUE INDEX invigilation_one_active_per_candidate
  ON invigilation_assignments (session_id, candidate_id) WHERE active;
CREATE INDEX invigilation_active_by_invigilator
  ON invigilation_assignments (invigilator_id) WHERE active;

-- Backstop for the 10-candidate hard limit. The service layer also enforces
-- it, but the database guarantees it even under concurrent writers: the
-- invigilator row is locked so two transactions cannot both see 9.
CREATE FUNCTION enforce_invigilator_capacity() RETURNS trigger AS $$
DECLARE
  cap     integer;
  current integer;
BEGIN
  IF NOT NEW.active THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.active AND OLD.invigilator_id = NEW.invigilator_id THEN
    RETURN NEW;
  END IF;

  SELECT max_active INTO cap FROM invigilators WHERE id = NEW.invigilator_id FOR UPDATE;
  SELECT count(*) INTO current FROM invigilation_assignments
    WHERE invigilator_id = NEW.invigilator_id AND active AND id <> NEW.id;

  IF current >= LEAST(cap, 10) THEN
    RAISE EXCEPTION 'invigilator % is at capacity (%)', NEW.invigilator_id, LEAST(cap, 10)
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invigilator_capacity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invigilation_capacity
  BEFORE INSERT OR UPDATE ON invigilation_assignments
  FOR EACH ROW EXECUTE FUNCTION enforce_invigilator_capacity();

CREATE TABLE invigilation_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  assignment_id   uuid NOT NULL REFERENCES invigilation_assignments(id),
  channel         text NOT NULL CHECK (channel IN ('voice', 'text')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  note            text
);

-- ---------------------------------------------------------------------------
-- Submission, results, notifications, support, integrations
-- ---------------------------------------------------------------------------

CREATE TABLE submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  attempt_id      uuid NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  package_sha256  text NOT NULL,
  status          text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'evidence_pending', 'verified', 'rejected')),
  received_at     timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz
);

CREATE TABLE results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  attempt_id      uuid NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  score           numeric(10,2),
  max_score       numeric(10,2),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'marked', 'moderated', 'released')),
  released_at     timestamptz
);

-- Also acts as the outbox for email delivery (spec section 20).
CREATE TABLE notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   uuid REFERENCES organisations(id) ON DELETE CASCADE,
  recipient_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  recipient_email   text,
  kind              text NOT NULL,
  channel           text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email', 'sms', 'push')),
  payload           jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  read_at           timestamptz,
  CHECK (recipient_user_id IS NOT NULL OR recipient_email IS NOT NULL)
);

CREATE TABLE support_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  candidate_id    uuid REFERENCES candidates(id),
  scope           text NOT NULL CHECK (scope IN ('organisation', 'platform')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  summary         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_configs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}',
  enabled         boolean NOT NULL DEFAULT false,
  UNIQUE (organisation_id, kind)
);

-- ---------------------------------------------------------------------------
-- Audit (spec sections 16, 19, 22): append only.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  organisation_id uuid REFERENCES organisations(id),
  actor_user_id   uuid REFERENCES users(id),
  action          text NOT NULL,
  target_type     text,
  target_id       text,
  data            jsonb NOT NULL DEFAULT '{}',
  ip              inet,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time ON audit_logs (organisation_id, created_at DESC);

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Published exam versions can never change (spec section 22: "Exam version
-- cannot change silently after candidates begin").
CREATE TRIGGER exam_versions_immutable
  BEFORE UPDATE OR DELETE ON exam_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Permission catalogue and default role templates (spec section 2)
-- ---------------------------------------------------------------------------

INSERT INTO permissions (key, description) VALUES
  ('exam:create',                   'Create and edit exams and question banks'),
  ('exam:publish',                  'Publish immutable exam versions'),
  ('session:manage',                'Create sessions and assign candidates'),
  ('candidate:view',                'View candidate records'),
  ('candidate:invite',              'Invite and import candidates'),
  ('candidate:approve',             'Approve, reject and block candidates'),
  ('invigilator:create',            'Add and manage invigilators'),
  ('invigilation:allocate',         'Allocate candidates to invigilators'),
  ('live:view',                     'View assigned candidates in the live console'),
  ('live:voice',                    'Start voice contact with candidates'),
  ('recording:view',                'View recordings'),
  ('recording:download',            'Download recordings'),
  ('report:view',                   'View reports'),
  ('result:release',                'Release results'),
  ('organisation:manage_users',     'Manage organisation users and roles'),
  ('organisation:manage_security',  'Manage organisation security policy'),
  ('audit:view',                    'View the audit log');

INSERT INTO roles (key, name) VALUES
  ('owner',        'Organisation Owner'),
  ('admin',        'Organisation Admin'),
  ('exam_manager', 'Exam Manager'),
  ('invigilator',  'Invigilator'),
  ('reviewer',     'Reviewer / Marker'),
  ('support',      'Support Agent');

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r CROSS JOIN permissions p
WHERE r.organisation_id IS NULL AND (
     r.key = 'owner'
  OR (r.key = 'admin' AND p.key NOT IN ('organisation:manage_security'))
  OR (r.key = 'exam_manager' AND p.key IN
       ('exam:create', 'exam:publish', 'session:manage', 'candidate:view', 'candidate:invite', 'report:view', 'result:release'))
  OR (r.key = 'invigilator' AND p.key IN ('live:view', 'live:voice'))
  OR (r.key = 'reviewer' AND p.key IN ('candidate:view', 'recording:view', 'report:view'))
  OR (r.key = 'support' AND p.key IN ('candidate:view'))
);
