-- Historical rows can legitimately predate persisted engine metadata. Retain that
-- absence as NULL so API DTO normalization can render Unknown instead of claiming
-- the old implicit Claude default.
ALTER TABLE pipeline_runs
  ALTER COLUMN agent DROP NOT NULL,
  ALTER COLUMN agent DROP DEFAULT,
  ALTER COLUMN agent_type DROP NOT NULL,
  ALTER COLUMN agent_type DROP DEFAULT;
