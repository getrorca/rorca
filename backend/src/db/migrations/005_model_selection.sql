-- US-003: Model selection for spec generation
-- Add preferred_model column to direction_layers so L3 can store a workspace default.
-- This file is a no-op marker; column addition handled programmatically in db/index.ts
-- because SQLite lacks ALTER TABLE ADD COLUMN IF NOT EXISTS.
SELECT 1;
