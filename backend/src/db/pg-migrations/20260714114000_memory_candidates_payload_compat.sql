-- Brownfield compatibility: memory_candidates predates the unified context
-- contract in existing installations. CREATE TABLE IF NOT EXISTS did not add
-- the payload column, while context-distillation writes it unconditionally.

ALTER TABLE memory_candidates
  ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT NULL;
