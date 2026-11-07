-- getOpenRouterPrefs has always accepted a workspace identity, but the original
-- table was global-only.  Add the missing nullable scope without assigning
-- legacy preferences to an arbitrary tenant: NULL remains the global fallback.
ALTER TABLE rorca.openrouter_provider_prefs
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

DO $migration$
DECLARE
  prefs_oid OID := 'rorca.openrouter_provider_prefs'::pg_catalog.regclass;
  workspaces_oid OID := 'rorca.workspaces'::pg_catalog.regclass;
  workspace_id_attnum SMALLINT;
  workspace_attnum SMALLINT;
  model_id_attnum SMALLINT;
  candidate_constraint TEXT;
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
BEGIN
  SELECT attnum INTO workspace_id_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = prefs_oid AND attname = 'workspace_id' AND NOT attisdropped;

  SELECT attnum INTO workspace_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = workspaces_oid AND attname = 'id' AND NOT attisdropped;

  SELECT attnum INTO model_id_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = prefs_oid AND attname = 'model_id' AND NOT attisdropped;

  IF workspace_id_attnum IS NULL OR workspace_attnum IS NULL OR model_id_attnum IS NULL THEN
    RAISE EXCEPTION 'OpenRouter preference scoping requires workspace_id, model_id, and rorca.workspaces.id';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = prefs_oid
      AND attname = 'workspace_id'
      AND NOT attisdropped
      AND atttypid = 'pg_catalog.text'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'rorca.openrouter_provider_prefs.workspace_id has an incompatible type';
  END IF;

  FOR candidate_constraint IN
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE conrelid = prefs_oid
      AND contype = 'f'
      AND conkey = ARRAY[workspace_id_attnum]::SMALLINT[]
      AND NOT (
        confrelid = workspaces_oid
        AND confkey = ARRAY[workspace_attnum]::SMALLINT[]
        AND confdeltype = 'c'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE rorca.openrouter_provider_prefs DROP CONSTRAINT %I',
      candidate_constraint
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = prefs_oid
      AND contype = 'f'
      AND conkey = ARRAY[workspace_id_attnum]::SMALLINT[]
      AND confrelid = workspaces_oid
      AND confkey = ARRAY[workspace_attnum]::SMALLINT[]
      AND confdeltype = 'c'
  ) THEN
    ALTER TABLE rorca.openrouter_provider_prefs
      ADD CONSTRAINT openrouter_provider_prefs_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES rorca.workspaces(id) ON DELETE CASCADE;
  END IF;

  -- The historical UNIQUE(model_id) would reject workspace overrides. Replace
  -- every relation-local copy by exact global and tenant uniqueness indexes.
  FOR candidate_constraint IN
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE conrelid = prefs_oid
      AND contype = 'u'
      AND conkey = ARRAY[model_id_attnum]::SMALLINT[]
  LOOP
    EXECUTE format(
      'ALTER TABLE rorca.openrouter_provider_prefs DROP CONSTRAINT %I',
      candidate_constraint
    );
  END LOOP;

  IF runtime_user IS NULL OR runtime_user = '' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  EXECUTE format(
    'GRANT SELECT ON rorca.openrouter_provider_prefs TO %I',
    runtime_user
  );
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_openrouter_provider_prefs_global_model
  ON rorca.openrouter_provider_prefs (model_id)
  WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_openrouter_provider_prefs_workspace_model
  ON rorca.openrouter_provider_prefs (workspace_id, model_id)
  WHERE workspace_id IS NOT NULL;
