-- 009_teams.sql — Teams, team members, workspace access

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'viewer')),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspace_access (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK(permission IN ('read', 'write', 'admin')),
  PRIMARY KEY (workspace_id, team_id)
);

-- Add FK constraint on direction_layers.team_id now that teams table exists
ALTER TABLE direction_layers
  ADD CONSTRAINT fk_direction_layers_team_id
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;

-- Add FK on templates.team_id and templates.author_id
ALTER TABLE templates
  ADD CONSTRAINT fk_templates_team_id
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;

ALTER TABLE templates
  ADD CONSTRAINT fk_templates_author_id
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_teams_owner_id ON teams(owner_id);
CREATE INDEX IF NOT EXISTS idx_teams_slug ON teams(slug);
CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_workspace_access_team_id ON workspace_access(team_id);
CREATE INDEX IF NOT EXISTS idx_workspace_access_workspace_id ON workspace_access(workspace_id);
