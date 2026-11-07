-- 20260820011000_spec_export_kit_multi_compiler_generations.sql
-- A compiler revision may produce a new immutable manifest for unchanged spec
-- material. The manifest, not the material hash alone, identifies a generation.

DO $$
DECLARE constraint_name TEXT;
BEGIN
  SELECT constraint_row.conname
    INTO constraint_name
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
   WHERE schema_row.nspname = 'rorca'
     AND table_row.relname = 'spec_export_kit_generations'
     AND constraint_row.contype = 'u'
     AND pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (workspace_id, spec_slug, spec_material_hash)'
   LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE rorca.spec_export_kit_generations DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

COMMENT ON COLUMN rorca.spec_export_kit_generations.spec_material_hash IS
  'Hash of canonical authoring material. Multiple immutable manifests are allowed when a compiler revision changes derived artifact bytes.';
