-- How long recordings are kept (spec sections 12 and 19). Counted from the
-- submission of the attempt. Null keeps them until deleted by hand.
ALTER TABLE organisations ADD COLUMN recording_retention_days integer
  CHECK (recording_retention_days IS NULL OR recording_retention_days BETWEEN 1 AND 3650);
UPDATE organisations SET recording_retention_days = 365;
ALTER TABLE organisations ALTER COLUMN recording_retention_days SET DEFAULT 365;

CREATE INDEX recording_chunks_retained ON recording_chunks (stream_id) WHERE retention_state = 'retained';
