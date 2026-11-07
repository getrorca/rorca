-- REA-008 forward repair: enabled profiles clear disabled_at, so the column
-- must be nullable. The profile CHECK constraint still requires a timestamp
-- whenever state is disabled.

ALTER TABLE rorca.execution_authority_profiles
  ALTER COLUMN disabled_at DROP NOT NULL;
