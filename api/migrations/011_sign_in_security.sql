-- Sign in security (spec sections 2 and 19): account lockout, two factor
-- codes for staff, staff invitations and password reset by email.

ALTER TABLE users
  ADD COLUMN failed_logins  integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until   timestamptz,
  -- Encrypted with a key derived from the server secret; never returned.
  ADD COLUMN totp_secret    text,
  -- Set during enrolment until the first code is confirmed.
  ADD COLUMN totp_pending   text,
  -- The last accepted time step, so a code cannot be used twice.
  ADD COLUMN totp_last_step bigint;

CREATE TABLE user_recovery_codes (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

-- Single use emailed links for people who are not candidates. Stored only as hashes.
CREATE TABLE user_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('staff_invitation', 'password_reset')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organisations ADD COLUMN require_staff_mfa boolean NOT NULL DEFAULT false;
