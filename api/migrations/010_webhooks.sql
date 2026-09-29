-- Webhooks to an organisation's own systems (spec section 24, MVP 8).
-- The endpoint and secret live in integration_configs (kind 'webhook').

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event           text NOT NULL,
  payload         jsonb NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  failed_at       timestamptz,
  last_status     integer,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE delivered_at IS NULL AND failed_at IS NULL;
CREATE INDEX webhook_deliveries_org ON webhook_deliveries (organisation_id, created_at DESC);
