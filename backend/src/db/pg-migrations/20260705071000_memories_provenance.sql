-- CCS-003: Structured provenance for memories promoted from context capture candidates.
-- Timestamp-format filename avoids numeric prefix collisions from parallel branches.

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'memories_provenance_object_check'
      AND conrelid = 'memories'::regclass
  ) THEN
    ALTER TABLE memories
      ADD CONSTRAINT memories_provenance_object_check
      CHECK (jsonb_typeof(provenance) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_memories_provenance
  ON memories USING GIN (provenance);
