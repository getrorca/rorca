-- Canonicalize installed-skill persistence on the relation used by the runtime.
-- Historical installations can contain public.installed_skills alongside the
-- application table.  Runtime SQL must never depend on search_path to choose
-- between those relations.
DO $migration$
DECLARE
  installed_skills_oid OID := to_regclass('rorca.installed_skills');
  public_installed_skills_oid OID := to_regclass('public.installed_skills');
  workspaces_oid OID := to_regclass('rorca.workspaces');
  installed_skills_kind "char";
  public_installed_skills_kind "char";
  workspace_id_attnum SMALLINT;
  workspace_attnum SMALLINT;
  name_attnum SMALLINT;
  candidate_constraint TEXT;
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  created_canonical_table BOOLEAN := FALSE;
BEGIN
  IF workspaces_oid IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class
    WHERE oid = workspaces_oid
      AND relkind IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'installed-skills canonicalization requires rorca.workspaces to be a table';
  END IF;

  IF installed_skills_oid IS NULL THEN
    CREATE TABLE rorca.installed_skills (
      id SERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user',
      content TEXT NOT NULL,
      category TEXT,
      tags TEXT,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT installed_skills_workspace_id_fkey
        FOREIGN KEY (workspace_id) REFERENCES rorca.workspaces(id) ON DELETE CASCADE,
      CONSTRAINT installed_skills_workspace_name_key UNIQUE (workspace_id, name)
    );
    installed_skills_oid := 'rorca.installed_skills'::pg_catalog.regclass;
    created_canonical_table := TRUE;
  END IF;

  SELECT relkind
  INTO installed_skills_kind
  FROM pg_catalog.pg_class
  WHERE oid = installed_skills_oid;

  IF installed_skills_kind NOT IN ('r', 'p') THEN
    RAISE EXCEPTION 'rorca.installed_skills must be a table, found relation kind %', installed_skills_kind;
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
    RAISE EXCEPTION 'installed-skills canonicalization requires rorca.installed_skills.name and rorca.workspaces.id';
  END IF;

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
    EXECUTE format('ALTER TABLE rorca.installed_skills DROP CONSTRAINT %I', candidate_constraint);
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
    ALTER TABLE rorca.installed_skills
      ADD CONSTRAINT installed_skills_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES rorca.workspaces(id) ON DELETE CASCADE;
  END IF;

  FOR candidate_constraint IN
    SELECT conname
    FROM pg_catalog.pg_constraint
    WHERE conrelid = installed_skills_oid
      AND contype = 'u'
      AND conkey = ARRAY[name_attnum]::SMALLINT[]
  LOOP
    EXECUTE format('ALTER TABLE rorca.installed_skills DROP CONSTRAINT %I', candidate_constraint);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = installed_skills_oid
      AND contype = 'u'
      AND conkey = ARRAY[workspace_id_attnum, name_attnum]::SMALLINT[]
  ) THEN
    ALTER TABLE rorca.installed_skills
      ADD CONSTRAINT installed_skills_workspace_name_key UNIQUE (workspace_id, name);
  END IF;

  CREATE INDEX IF NOT EXISTS idx_installed_skills_workspace_name
    ON rorca.installed_skills (workspace_id, name);

  -- A public-only legacy installation has no canonical runtime table.  Import
  -- its retained rows without making public part of runtime relation lookup.
  IF created_canonical_table
    AND public_installed_skills_oid IS NOT NULL THEN
    SELECT relkind
    INTO public_installed_skills_kind
    FROM pg_catalog.pg_class
    WHERE oid = public_installed_skills_oid;

    IF public_installed_skills_kind IN ('r', 'p') THEN
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute
        WHERE attrelid = public_installed_skills_oid
          AND attname = 'workspace_id'
          AND NOT attisdropped
      ) THEN
        IF to_regclass('public.workspaces') IS NOT NULL THEN
          INSERT INTO rorca.workspaces (id, label, path)
          SELECT source_workspace.id, source_workspace.label, source_workspace.path
          FROM public.workspaces AS source_workspace
          WHERE EXISTS (
            SELECT 1
            FROM public.installed_skills AS source_skill
            WHERE source_skill.workspace_id = source_workspace.id
          )
          ON CONFLICT (id) DO NOTHING;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM public.installed_skills AS source_skill
          LEFT JOIN rorca.workspaces AS target_workspace
            ON target_workspace.id = source_skill.workspace_id
          WHERE target_workspace.id IS NULL
        ) THEN
          RAISE EXCEPTION 'public.installed_skills contains a workspace absent from rorca.workspaces';
        END IF;

        INSERT INTO rorca.installed_skills
          (workspace_id, name, description, source, content, category, tags, installed_at, updated_at)
        SELECT workspace_id, name, description, source, content, category, tags, installed_at, updated_at
        FROM public.installed_skills
        ON CONFLICT (workspace_id, name) DO NOTHING;
      ELSE
        INSERT INTO rorca.installed_skills
          (workspace_id, name, description, source, content, category, tags, installed_at, updated_at)
        SELECT 'rorca:system:legacy-installed-skills', name, description, source, content,
          category, tags, installed_at, updated_at
        FROM public.installed_skills
        ON CONFLICT (workspace_id, name) DO NOTHING;
      END IF;
    END IF;
  END IF;

  IF runtime_user IS NULL OR runtime_user = '' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON rorca.installed_skills TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT USAGE, SELECT ON SEQUENCE rorca.installed_skills_id_seq TO %I',
    runtime_user
  );
END
$migration$;
