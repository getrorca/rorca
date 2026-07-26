-- Bind the derived spec search projection to canonical spec_versions.workspace_id.
-- Legacy NULL-workspace snapshots remain unreadable from workspace-scoped paths.

CREATE OR REPLACE FUNCTION update_spec_search_index() RETURNS trigger AS $$
DECLARE
  v_title TEXT;
  v_story_titles TEXT;
  v_story_descriptions TEXT;
  v_acceptance_criteria TEXT;
  v_generated_at TIMESTAMPTZ;
  v_stories JSONB;
BEGIN
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- An older global version must never overwrite this workspace's latest
  -- derived projection when historical rows are replayed or repaired.
  IF EXISTS (
    SELECT 1
      FROM spec_versions newer
     WHERE newer.workspace_id = NEW.workspace_id
       AND newer.spec_slug = NEW.spec_slug
       AND (newer.version > NEW.version OR (newer.version = NEW.version AND newer.id > NEW.id))
  ) THEN
    RETURN NEW;
  END IF;

  v_title := COALESCE(NEW.content_json ->> 'title', NEW.spec_slug);
  v_stories := COALESCE(NEW.content_json -> 'userStories', NEW.content_json -> 'stories', '[]'::jsonb);

  SELECT COALESCE(string_agg(elem ->> 'title', ' | '), '')
    INTO v_story_titles
    FROM jsonb_array_elements(v_stories) AS elem
   WHERE elem ->> 'title' IS NOT NULL AND elem ->> 'title' != '';

  SELECT COALESCE(string_agg(elem ->> 'description', ' | '), '')
    INTO v_story_descriptions
    FROM jsonb_array_elements(v_stories) AS elem
   WHERE elem ->> 'description' IS NOT NULL AND elem ->> 'description' != '';

  SELECT COALESCE(string_agg(ac.value #>> '{}', ' | '), '')
    INTO v_acceptance_criteria
    FROM jsonb_array_elements(v_stories) AS elem,
         jsonb_array_elements(COALESCE(elem -> 'acceptanceCriteria', '[]'::jsonb)) AS ac(value);

  v_generated_at := COALESCE(
    (NEW.content_json ->> 'generatedAt')::timestamptz,
    NEW.created_at
  );

  INSERT INTO spec_search_index (
    spec_slug, workspace_id, spec_title, story_titles, story_descriptions,
    acceptance_criteria, status, generated_at
  ) VALUES (
    NEW.spec_slug, NEW.workspace_id, v_title, v_story_titles,
    v_story_descriptions, v_acceptance_criteria, NEW.status, v_generated_at
  )
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

-- Remove only derived rows whose workspace has no canonical version authority
-- for that slug. File-backed archive entries are rebuilt on the next scoped
-- archive read; retaining a potentially cross-workspace projection is unsafe.
DELETE FROM spec_search_index search
WHERE EXISTS (
  SELECT 1 FROM spec_versions any_version
   WHERE any_version.spec_slug = search.spec_slug
)
AND NOT EXISTS (
  SELECT 1 FROM spec_versions exact_version
   WHERE exact_version.workspace_id = search.workspace_id
     AND exact_version.spec_slug = search.spec_slug
);

-- Deterministically repopulate each exact workspace/slug projection from only
-- its latest canonical version using the trigger above.
UPDATE spec_versions current_version
   SET workspace_id = current_version.workspace_id
 WHERE current_version.workspace_id IS NOT NULL
   AND current_version.id = (
     SELECT latest.id
       FROM spec_versions latest
      WHERE latest.workspace_id = current_version.workspace_id
        AND latest.spec_slug = current_version.spec_slug
      ORDER BY latest.version DESC, latest.id DESC
      LIMIT 1
   );
