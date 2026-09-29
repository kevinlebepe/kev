-- Invigilator presence for automatic failover (spec sections 7 and 8).
ALTER TABLE invigilators ADD COLUMN last_seen_at timestamptz;
