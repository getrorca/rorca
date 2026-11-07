-- Forward-only remediation for installations where the already-recorded
-- 20260806120400 migration upgraded public.installed_skills while the runtime
-- search_path (rorca, public) continued to resolve rorca.installed_skills.
--
-- Deliberately do nothing when rorca.installed_skills is absent or is a view:
-- fresh/public-only and schema-alias installations retain their existing backing
-- table instead of receiving a duplicate or destructive public migration.
DO $migration$
DECLARE
  installed_skills_oid OID := to_regclass('rorca.installed_skills');
  workspaces_oid OID := to_regclass('rorca.workspaces');
  installed_skills_kind "char";
  workspaces_kind "char";
  workspace_attnum SMALLINT;
  workspace_id_attnum SMALLINT;
  name_attnum SMALLINT;
  candidate_constraint TEXT;
  candidate_index TEXT;
  scoped_index_columns TEXT[];
BEGIN
  IF installed_skills_oid IS NULL THEN
    RETURN;
  END IF;

  SELECT relkind
  INTO installed_skills_kind
  FROM pg_catalog.pg_class
  WHERE oid = installed_skills_oid;

  IF installed_skills_kind NOT IN ('r', 'p') THEN
    RETURN;
  END IF;

  IF workspaces_oid IS NULL THEN
    RAISE EXCEPTION 'rorca.installed_skills exists without rorca.workspaces';
  END IF;

  SELECT relkind
  INTO workspaces_kind
  FROM pg_catalog.pg_class
  WHERE oid = workspaces_oid;

  IF workspaces_kind NOT IN ('r', 'p') THEN
    RAISE EXCEPTION 'rorca.workspaces must be a table when rorca.installed_skills is a table';
  END IF;

  INSERT INTO rorca.workspaces (id, label, path)
  VALUES (
    'rorca:system:legacy-installed-skills',
    '[System] Legacy Installed Skills (unscoped)',
    'system://legacy-installed-skills'
  )
  ON CONFLICT (id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM rorca.workspaces
    WHERE id = 'rorca:system:legacy-installed-skills'
      AND label = '[System] Legacy Installed Skills (unscoped)'
      AND path = 'system://legacy-installed-skills'
  ) THEN
    RAISE EXCEPTION 'reserved legacy installed-skills workspace id is already in use';
  END IF;

  ALTER TABLE rorca.installed_skills
    ADD COLUMN IF NOT EXISTS workspace_id TEXT;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = installed_skills_oid
      AND attname = 'workspace_id'
      AND NOT attisdropped
      AND atttypid = 'pg_catalog.text'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'rorca.installed_skills.workspace_id exists with an incompatible type';
  END IF;

  UPDATE rorca.installed_skills
  SET workspace_id = 'rorca:system:legacy-installed-skills'
  WHERE workspace_id IS NULL;

  ALTER TABLE rorca.installed_skills
    ALTER COLUMN workspace_id SET NOT NULL;

  SELECT attnum
  INTO workspace_id_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = installed_skills_oid
    AND attname = 'workspace_id'
    AND NOT attisdropped;

  SELECT attnum
  INTO name_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = installed_skills_oid
    AND attname = 'name'
    AND NOT attisdropped;

  SELECT attnum
  INTO workspace_attnum
  FROM pg_catalog.pg_attribute
  WHERE attrelid = workspaces_oid
    AND attname = 'id'
    AND NOT attisdropped;

  IF name_attnum IS NULL OR workspace_attnum IS NULL THEN
    RAISE EXCEPTION 'installed-skills remediation requires rorca.installed_skills.name and rorca.workspaces.id';
  END IF;

  -- Remove an incorrect single-column workspace FK before installing the exact
  -- rorca.workspaces ON DELETE CASCADE contract. Constraint checks are bound to
  -- the target relation OID, never to an unqualified constraint name.
  FOR candidate_constraint IN
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE conrelid = installed_skills_oid
      AND contype = 'f'
      AND conkey = ARRAY[workspace_id_attnum]::SMALLINT[]
      AND NOT (
        confrelid = workspaces_oid
        AND confkey = ARRAY[workspace_attnum]::SMALLINT[]
        AND confdeltype = 'c'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE rorca.installed_skills DROP CONSTRAINT %I',
      candidate_constraint
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = installed_skills_oid
      AND contype = 'f'
      AND conkey = ARRAY[workspace_id_attnum]::SMALLINT[]
      AND confrelid = workspaces_oid
      AND confkey = ARRAY[workspace_attnum]::SMALLINT[]
      AND confdeltype = 'c'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint
      WHERE conrelid = installed_skills_oid
        AND conname = 'installed_skills_workspace_id_fkey'
    ) THEN
      RAISE EXCEPTION 'installed_skills_workspace_id_fkey is already used by an incompatible constraint';
    END IF;

    ALTER TABLE rorca.installed_skills
      ADD CONSTRAINT installed_skills_workspace_id_fkey
      FOREIGN KEY (workspace_id)
      REFERENCES rorca.workspaces(id)
      ON DELETE CASCADE;
  END IF;

  -- Remove every relation-local global name-only uniqueness constraint. This
  -- also removes its backing index without guessing a schema-global name.
  FOR candidate_constraint IN
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE conrelid = installed_skills_oid
      AND contype = 'u'
      AND conkey = ARRAY[name_attnum]::SMALLINT[]
  LOOP
    EXECUTE format(
      'ALTER TABLE rorca.installed_skills DROP CONSTRAINT %I',
      candidate_constraint
    );
  END LOOP;

  -- Remove standalone name-only indexes left by historical installations.
  FOR candidate_index IN
    SELECT index_class.relname
    FROM pg_catalog.pg_index AS index_definition
    JOIN pg_catalog.pg_class AS index_class
      ON index_class.oid = index_definition.indexrelid
    WHERE index_definition.indrelid = installed_skills_oid
      AND index_definition.indnkeyatts = 1
      AND index_definition.indnatts = 1
      AND NOT index_definition.indisprimary
      AND index_definition.indexprs IS NULL
      AND index_definition.indpred IS NULL
      AND (
        SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
        FROM unnest(index_definition.indkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = installed_skills_oid
         AND attribute.attnum = key.attnum
        WHERE key.ordinality <= index_definition.indnkeyatts
      ) = ARRAY['name']::TEXT[]
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint
        WHERE conindid = index_definition.indexrelid
      )
  LOOP
    EXECUTE format('DROP INDEX rorca.%I', candidate_index);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = installed_skills_oid
      AND contype = 'u'
      AND conkey = ARRAY[workspace_id_attnum, name_attnum]::SMALLINT[]
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint
      WHERE conrelid = installed_skills_oid
        AND conname = 'installed_skills_workspace_name_key'
    ) THEN
      RAISE EXCEPTION 'installed_skills_workspace_name_key is already used by an incompatible constraint';
    END IF;

    ALTER TABLE rorca.installed_skills
      ADD CONSTRAINT installed_skills_workspace_name_key
      UNIQUE (workspace_id, name);
  END IF;

  IF to_regclass('rorca.idx_installed_skills_workspace_name') IS NULL THEN
    CREATE INDEX idx_installed_skills_workspace_name
      ON rorca.installed_skills (workspace_id, name);
  ELSE
    SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
    INTO scoped_index_columns
    FROM pg_catalog.pg_index AS index_definition
    JOIN unnest(index_definition.indkey) WITH ORDINALITY AS key(attnum, ordinality)
      ON key.ordinality <= index_definition.indnkeyatts
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = installed_skills_oid
     AND attribute.attnum = key.attnum
    WHERE index_definition.indexrelid = to_regclass('rorca.idx_installed_skills_workspace_name')
      AND index_definition.indrelid = installed_skills_oid
      AND index_definition.indnkeyatts = 2
      AND index_definition.indnatts = 2
      AND index_definition.indexprs IS NULL
      AND index_definition.indpred IS NULL;

    IF scoped_index_columns IS DISTINCT FROM ARRAY['workspace_id', 'name']::TEXT[] THEN
      RAISE EXCEPTION 'rorca.idx_installed_skills_workspace_name is already used by an incompatible index';
    END IF;
  END IF;
END
$migration$;
