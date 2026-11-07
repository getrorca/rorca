-- Installed skills were historically global, so legacy rows have no schema-backed
-- workspace owner. Preserve them under a reserved system workspace instead of
-- guessing an arbitrary user workspace. Application skill reads reject this
-- reserved scope, making these rows retained for explicit operator disposition
-- but invisible to every user-workspace catalog.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM installed_skills) THEN
    INSERT INTO workspaces (id, label, path)
    VALUES (
      'rorca:system:legacy-installed-skills',
      '[System] Legacy Installed Skills (unscoped)',
      'system://legacy-installed-skills'
    )
    ON CONFLICT (id) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM workspaces
      WHERE id = 'rorca:system:legacy-installed-skills'
        AND label = '[System] Legacy Installed Skills (unscoped)'
        AND path = 'system://legacy-installed-skills'
    ) THEN
      RAISE EXCEPTION 'reserved legacy installed-skills workspace id is already in use';
    END IF;
  END IF;
END $$;

ALTER TABLE installed_skills
  ADD COLUMN workspace_id TEXT;

UPDATE installed_skills
SET workspace_id = 'rorca:system:legacy-installed-skills'
WHERE workspace_id IS NULL;

ALTER TABLE installed_skills
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT installed_skills_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE installed_skills
  DROP CONSTRAINT installed_skills_name_key,
  ADD CONSTRAINT installed_skills_workspace_name_key UNIQUE (workspace_id, name);

DROP INDEX IF EXISTS idx_installed_skills_name;

CREATE INDEX idx_installed_skills_workspace_name
  ON installed_skills (workspace_id, name);
