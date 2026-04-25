-- 057_spec_search_auto_index.sql — Auto-populate spec_search_index from spec_versions trigger

-- Function: extract searchable fields from spec_versions.content_json and upsert into spec_search_index
CREATE OR REPLACE FUNCTION update_spec_search_index() RETURNS trigger AS $$
DECLARE
  v_title TEXT;
  v_story_titles TEXT;
  v_story_descriptions TEXT;
  v_acceptance_criteria TEXT;
  v_workspace_id TEXT;
  v_generated_at TIMESTAMPTZ;
  v_stories JSONB;
BEGIN
  -- Extract title from content_json
  v_title := COALESCE(NEW.content_json ->> 'title', NEW.spec_slug);

  -- Extract stories array (userStories preferred, stories as fallback)
  v_stories := COALESCE(NEW.content_json -> 'userStories', NEW.content_json -> 'stories', '[]'::jsonb);

  -- Concatenate story titles
  SELECT COALESCE(string_agg(elem ->> 'title', ' | '), '')
    INTO v_story_titles
    FROM jsonb_array_elements(v_stories) AS elem
   WHERE elem ->> 'title' IS NOT NULL AND elem ->> 'title' != '';

  -- Concatenate story descriptions
  SELECT COALESCE(string_agg(elem ->> 'description', ' | '), '')
    INTO v_story_descriptions
    FROM jsonb_array_elements(v_stories) AS elem
   WHERE elem ->> 'description' IS NOT NULL AND elem ->> 'description' != '';

  -- Concatenate acceptance criteria (nested arrays flattened)
  SELECT COALESCE(string_agg(ac.value #>> '{}', ' | '), '')
    INTO v_acceptance_criteria
    FROM jsonb_array_elements(v_stories) AS elem,
         jsonb_array_elements(COALESCE(elem -> 'acceptanceCriteria', '[]'::jsonb)) AS ac(value);

  -- Look up workspace_id from wal_events (best-effort, most recent event for this spec)
  SELECT we.workspace_id INTO v_workspace_id
    FROM wal_events we
   WHERE we.spec_id = NEW.spec_slug AND we.workspace_id IS NOT NULL
   ORDER BY we.ts DESC LIMIT 1;

  v_workspace_id := COALESCE(v_workspace_id, '');

  -- Extract generatedAt
  v_generated_at := COALESCE(
    (NEW.content_json ->> 'generatedAt')::timestamptz,
    NEW.created_at
  );

  -- Upsert into spec_search_index (keyed on spec_slug + workspace_id)
  INSERT INTO spec_search_index (spec_slug, workspace_id, spec_title, story_titles, story_descriptions, acceptance_criteria, status, generated_at)
  VALUES (NEW.spec_slug, v_workspace_id, v_title, v_story_titles, v_story_descriptions, v_acceptance_criteria, NEW.status, v_generated_at)
  ON CONFLICT (spec_slug, workspace_id)
    DO UPDATE SET
      spec_title = EXCLUDED.spec_title,
      story_titles = EXCLUDED.story_titles,
      story_descriptions = EXCLUDED.story_descriptions,
      acceptance_criteria = EXCLUDED.acceptance_criteria,
      status = EXCLUDED.status,
      generated_at = EXCLUDED.generated_at;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add unique constraint for upsert target (if not exists).
-- Scope the check to the rorca.spec_search_index table specifically: some older/dev
-- databases also contain a legacy public.spec_search_index table, and checking only
-- the constraint name can falsely skip creating the constraint on the real target
-- table used by this migration.
DO $$
DECLARE
  v_target regclass;
BEGIN
  v_target := to_regclass('spec_search_index');

  IF v_target IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_spec_search_slug_workspace'
      AND conrelid = v_target
  ) THEN
    ALTER TABLE spec_search_index ADD CONSTRAINT uq_spec_search_slug_workspace UNIQUE (spec_slug, workspace_id);
  END IF;
END $$;

-- Create trigger on spec_versions
DROP TRIGGER IF EXISTS trg_spec_versions_search ON spec_versions;
CREATE TRIGGER trg_spec_versions_search
  AFTER INSERT OR UPDATE ON spec_versions
  FOR EACH ROW EXECUTE FUNCTION update_spec_search_index();

-- Backfill: index all existing spec_versions (latest version per slug)
INSERT INTO spec_search_index (spec_slug, workspace_id, spec_title, story_titles, story_descriptions, acceptance_criteria, status, generated_at)
SELECT
  sv.spec_slug,
  COALESCE(
    (SELECT we.workspace_id FROM wal_events we WHERE we.spec_id = sv.spec_slug AND we.workspace_id IS NOT NULL ORDER BY we.ts DESC LIMIT 1),
    ''
  ) AS workspace_id,
  COALESCE(sv.content_json ->> 'title', sv.spec_slug) AS spec_title,
  COALESCE(
    (SELECT string_agg(elem ->> 'title', ' | ')
       FROM jsonb_array_elements(COALESCE(sv.content_json -> 'userStories', sv.content_json -> 'stories', '[]'::jsonb)) AS elem
      WHERE elem ->> 'title' IS NOT NULL AND elem ->> 'title' != ''),
    ''
  ) AS story_titles,
  COALESCE(
    (SELECT string_agg(elem ->> 'description', ' | ')
       FROM jsonb_array_elements(COALESCE(sv.content_json -> 'userStories', sv.content_json -> 'stories', '[]'::jsonb)) AS elem
      WHERE elem ->> 'description' IS NOT NULL AND elem ->> 'description' != ''),
    ''
  ) AS story_descriptions,
  COALESCE(
    (SELECT string_agg(ac.value #>> '{}', ' | ')
       FROM jsonb_array_elements(COALESCE(sv.content_json -> 'userStories', sv.content_json -> 'stories', '[]'::jsonb)) AS elem,
            jsonb_array_elements(COALESCE(elem -> 'acceptanceCriteria', '[]'::jsonb)) AS ac(value)),
    ''
  ) AS acceptance_criteria,
  sv.status,
  COALESCE((sv.content_json ->> 'generatedAt')::timestamptz, sv.created_at) AS generated_at
FROM spec_versions sv
WHERE sv.version = (
  SELECT MAX(sv2.version) FROM spec_versions sv2 WHERE sv2.spec_slug = sv.spec_slug
)
ON CONFLICT (spec_slug, workspace_id)
  DO UPDATE SET
    spec_title = EXCLUDED.spec_title,
    story_titles = EXCLUDED.story_titles,
    story_descriptions = EXCLUDED.story_descriptions,
    acceptance_criteria = EXCLUDED.acceptance_criteria,
    status = EXCLUDED.status,
    generated_at = EXCLUDED.generated_at;
