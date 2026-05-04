SET search_path TO rorca, public;

CREATE TABLE IF NOT EXISTS spec_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('enrich','match-skills','suggest-skills','suggest-models','detect-dependencies','knowledge-graph','add-stories','validate','score')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
  progress_current INTEGER DEFAULT 0,
  progress_total INTEGER DEFAULT 0,
  progress_message TEXT,
  request_payload JSONB,
  result_payload JSONB,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spec_jobs_workspace_spec
  ON spec_jobs(workspace_id, spec_id);

CREATE INDEX IF NOT EXISTS idx_spec_jobs_status
  ON spec_jobs(status)
  WHERE status IN ('pending', 'running');

SET search_path TO public;
