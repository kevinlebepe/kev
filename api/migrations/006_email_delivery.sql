-- Email delivery from the notifications outbox (spec sections 14 and 20).
ALTER TABLE notifications
  ADD COLUMN attempts   integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error text,
  -- Set when delivery is abandoned after too many failures.
  ADD COLUMN failed_at  timestamptz;

CREATE INDEX notifications_email_due ON notifications (created_at)
  WHERE channel = 'email' AND sent_at IS NULL AND failed_at IS NULL;
