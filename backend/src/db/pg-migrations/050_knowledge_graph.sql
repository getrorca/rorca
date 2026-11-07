-- 050_knowledge_graph.sql — Apache AGE capability declaration for Rorca
-- PG-015: Graph layer capturing relationships between stories, files,
-- memory entries, conventions, specs, workspaces, and skills.
--
-- Historical builds created an AGE graph named `rorca`. That identifier now
-- belongs exclusively to the application schema, so this migration must never
-- create, adopt, or mutate the obsolete graph. The migration runner installs
-- AGE when permitted and then invokes the idempotent production lifecycle
-- bootstrap for the reviewed `rorca_v2` graph, including on databases where
-- version 050 was recorded by an older release.

CREATE EXTENSION IF NOT EXISTS age;
