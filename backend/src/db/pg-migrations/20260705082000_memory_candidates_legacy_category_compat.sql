-- CCS-015 hardening: tolerate brownfield memory_candidates tables that
-- already had a legacy NOT NULL category column before the sidecar schema
-- introduced suggested_category.
--
-- Fresh installs do not have memory_candidates.category. Existing local DBs may,
-- and inserts that only set suggested_category must still work.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'memory_candidates'
      AND column_name = 'category'
  ) THEN
    UPDATE memory_candidates
       SET category = COALESCE(NULLIF(btrim(category), ''), suggested_category, 'Decision')
     WHERE category IS NULL
        OR btrim(category) = '';

    ALTER TABLE memory_candidates
      ALTER COLUMN category SET DEFAULT 'Decision';

    ALTER TABLE memory_candidates
      ALTER COLUMN category DROP NOT NULL;

    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION memory_candidates_sync_legacy_category()
      RETURNS trigger AS $body$
      BEGIN
        IF NEW.category IS NULL OR btrim(NEW.category) = '' THEN
          NEW.category := COALESCE(NEW.suggested_category, 'Decision');
        END IF;
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql
    $fn$;

    DROP TRIGGER IF EXISTS memory_candidates_sync_legacy_category ON memory_candidates;

    CREATE TRIGGER memory_candidates_sync_legacy_category
      BEFORE INSERT OR UPDATE OF category, suggested_category ON memory_candidates
      FOR EACH ROW
      EXECUTE FUNCTION memory_candidates_sync_legacy_category();
  END IF;
END $$;
