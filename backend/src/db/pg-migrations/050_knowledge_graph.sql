-- 050_knowledge_graph.sql — Apache AGE knowledge graph for Rorca
-- PG-015: Graph layer capturing relationships between stories, files,
-- memory entries, conventions, specs, workspaces, and skills.

-- Enable Apache AGE extension (idempotent)
CREATE EXTENSION IF NOT EXISTS age;

-- Load the AGE library and set search_path so Cypher functions resolve
-- SET LOCAL scopes the change to this transaction only — does not bleed into later migrations
LOAD 'age';
SET LOCAL search_path = ag_catalog, "$user", public;

-- Create the rorca graph (only if it doesn't exist).
--
-- Fresh PostgreSQL installs now create the application schema `rorca` before
-- running migration 001 so every unqualified application table has a stable
-- home. Apache AGE also uses the graph name as its backing schema name and
-- create_graph('rorca') refuses to adopt an existing schema. Bridge that fresh-
-- install collision transactionally: rename the application schema, let AGE
-- create/register its graph schema, then move the application relations into
-- the AGE-owned schema. ALTER TABLE carries owned sequences and indexes with
-- each table. Existing databases that already have the graph skip this block.
DO $$
DECLARE
  relation_record RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'rorca'
  ) THEN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'rorca') THEN
      IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'rorca_pre_age_050') THEN
        RAISE EXCEPTION 'temporary AGE bridge schema rorca_pre_age_050 already exists';
      END IF;

      ALTER SCHEMA rorca RENAME TO rorca_pre_age_050;
      PERFORM create_graph('rorca');

      -- 048/049 were created on the application search_path. Relocate their
      -- complete extension object sets before dropping the bridge schema.
      IF EXISTS (
        SELECT 1 FROM pg_extension
         WHERE extname = 'pgcrypto'
           AND extnamespace = 'rorca_pre_age_050'::regnamespace
      ) THEN
        ALTER EXTENSION pgcrypto SET SCHEMA public;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_extension
         WHERE extname = 'vector'
           AND extnamespace = 'rorca_pre_age_050'::regnamespace
      ) THEN
        ALTER EXTENSION vector SET SCHEMA public;
      END IF;

      FOR relation_record IN
        SELECT c.relname, c.relkind
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'rorca_pre_age_050'
           AND c.relkind IN ('r', 'p')
         ORDER BY c.relname
      LOOP
        EXECUTE format('ALTER TABLE %I.%I SET SCHEMA rorca', 'rorca_pre_age_050', relation_record.relname);
      END LOOP;

      -- Move any standalone sequences not carried with an owned table.
      FOR relation_record IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'rorca_pre_age_050'
           AND c.relkind = 'S'
         ORDER BY c.relname
      LOOP
        EXECUTE format('ALTER SEQUENCE %I.%I SET SCHEMA rorca', 'rorca_pre_age_050', relation_record.relname);
      END LOOP;

      -- Trigger/helper functions are not carried with their owning tables.
      FOR relation_record IN
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS identity_arguments
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'rorca_pre_age_050'
         ORDER BY p.proname, p.oid
      LOOP
        EXECUTE format(
          'ALTER FUNCTION %I.%I(%s) SET SCHEMA rorca',
          'rorca_pre_age_050', relation_record.proname, relation_record.identity_arguments
        );
      END LOOP;

      IF EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'rorca_pre_age_050'
           AND c.relkind NOT IN ('i', 'I')
      ) THEN
        RAISE EXCEPTION 'unsupported application object remains in AGE bridge schema';
      END IF;

      DROP SCHEMA rorca_pre_age_050;
    ELSE
      PERFORM create_graph('rorca');
    END IF;
  END IF;
END $$;

-- Vertex labels (node types)
-- AGE creates these lazily on first MERGE, but explicit creation
-- ensures the labels exist for schema introspection.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'Story' AND kind = 'v'
  ) THEN
    PERFORM create_vlabel('rorca', 'Story');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'File' AND kind = 'v'
  ) THEN
    PERFORM create_vlabel('rorca', 'File');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'Memory' AND kind = 'v'
  ) THEN
    PERFORM create_vlabel('rorca', 'Memory');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'Spec' AND kind = 'v'
  ) THEN
    PERFORM create_vlabel('rorca', 'Spec');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'Convention' AND kind = 'v'
  ) THEN
    PERFORM create_vlabel('rorca', 'Convention');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'Workspace' AND kind = 'v'
  ) THEN
    PERFORM create_vlabel('rorca', 'Workspace');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'Skill' AND kind = 'v'
  ) THEN
    PERFORM create_vlabel('rorca', 'Skill');
  END IF;

  -- Edge labels (relationship types)
  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'TOUCHES' AND kind = 'e'
  ) THEN
    PERFORM create_elabel('rorca', 'TOUCHES');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'BELONGS_TO' AND kind = 'e'
  ) THEN
    PERFORM create_elabel('rorca', 'BELONGS_TO');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'DEPENDS_ON' AND kind = 'e'
  ) THEN
    PERFORM create_elabel('rorca', 'DEPENDS_ON');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'LEARNED_FROM' AND kind = 'e'
  ) THEN
    PERFORM create_elabel('rorca', 'LEARNED_FROM');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'ABOUT' AND kind = 'e'
  ) THEN
    PERFORM create_elabel('rorca', 'ABOUT');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'APPLIES_TO' AND kind = 'e'
  ) THEN
    PERFORM create_elabel('rorca', 'APPLIES_TO');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'VIOLATED_BY' AND kind = 'e'
  ) THEN
    PERFORM create_elabel('rorca', 'VIOLATED_BY');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'USED_IN' AND kind = 'e'
  ) THEN
    PERFORM create_elabel('rorca', 'USED_IN');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label
    WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = 'rorca')
      AND name = 'IN_WORKSPACE' AND kind = 'e'
  ) THEN
    PERFORM create_elabel('rorca', 'IN_WORKSPACE');
  END IF;
END $$;
