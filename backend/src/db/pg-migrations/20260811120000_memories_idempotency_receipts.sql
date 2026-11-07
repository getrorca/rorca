-- Make memory writes replay-safe for durable external synchronizers.
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_workspace_idempotency
  ON memories (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
