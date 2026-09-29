-- Events written in one transaction share a timestamp, so the timeline needs
-- a tiebreak that reflects the order they were recorded in.
ALTER TABLE events ADD COLUMN seq bigserial;
