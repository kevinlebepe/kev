-- Single sign on with OpenID Connect (spec sections 3 and 16): each
-- organisation can add its own identity providers, such as a university's
-- Microsoft Entra ID or Google Workspace.

CREATE TABLE identity_providers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  issuer                text NOT NULL,
  client_id             text NOT NULL,
  -- Encrypted with a key derived from the server secret; never returned.
  client_secret_sealed  text,
  scopes                text NOT NULL DEFAULT 'openid email profile',
  for_staff             boolean NOT NULL DEFAULT true,
  for_candidates        boolean NOT NULL DEFAULT true,
  -- Someone the provider vouches for, with an email the organisation has no
  -- candidate for, is registered and waits for approval.
  create_candidates     boolean NOT NULL DEFAULT false,
  -- The provider enforces its own two factor sign in, so staff who sign in
  -- through it are not also asked for an ExamGuard code.
  trust_mfa             boolean NOT NULL DEFAULT true,
  enabled               boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_providers_org ON identity_providers (organisation_id);

-- One sign in in progress: from leaving for the provider to handing the
-- tokens to the app. Only hashes of the state and the hand over code are kept.
CREATE TABLE sso_logins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash      text NOT NULL UNIQUE,
  provider_id     uuid NOT NULL REFERENCES identity_providers(id) ON DELETE CASCADE,
  app             text NOT NULL CHECK (app IN ('candidate', 'portal')),
  nonce           text NOT NULL,
  code_verifier   text NOT NULL,
  expires_at      timestamptz NOT NULL,
  handover_hash   text UNIQUE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  mfa_by_provider boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Refreshing keeps how the person signed in.
ALTER TABLE refresh_tokens ADD COLUMN amr text;
