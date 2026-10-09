-- Recording upload (spec section 12, MVP 4).

ALTER TABLE recording_chunks
  ADD COLUMN content_type text NOT NULL DEFAULT 'video/webm',
  ADD COLUMN size_bytes   integer NOT NULL DEFAULT 0;

-- A camera still for the live console, replaced every few seconds.
ALTER TABLE attempts
  ADD COLUMN snapshot_key text,
  ADD COLUMN snapshot_at  timestamptz,
  -- The last chunk sequence of each stream, declared by the app when it has
  -- finished uploading: { "camera": 41, "screen": 120 }.
  ADD COLUMN recording_manifest jsonb;
