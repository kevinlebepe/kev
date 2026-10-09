-- The exam event checklist (spec section 21): items people confirm by hand
-- before a session, such as a tested backup. The rest are worked out.

CREATE TABLE session_checklist (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item       text NOT NULL,
  done_by    uuid REFERENCES users(id),
  done_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, item)
);
