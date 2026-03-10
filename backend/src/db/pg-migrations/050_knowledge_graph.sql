-- 050_knowledge_graph.sql — Apache AGE knowledge graph for Rorca
-- PG-015: Graph layer capturing relationships between stories, files,
-- memory entries, conventions, specs, workspaces, and skills.

-- Enable Apache AGE extension (idempotent)
CREATE EXTENSION IF NOT EXISTS age;

-- Load the AGE library and set search_path so Cypher functions resolve
-- SET LOCAL scopes the change to this transaction only — does not bleed into later migrations
LOAD 'age';
SET LOCAL search_path = ag_catalog, "$user", public;

-- Create the rorca graph (only if it doesn't exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'rorca'
  ) THEN
    PERFORM create_graph('rorca');
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
