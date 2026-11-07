-- 026_onboarding_state.sql — Onboarding wizard state persistence

CREATE TABLE IF NOT EXISTS onboarding_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  current_step INTEGER NOT NULL DEFAULT 0,
  workspace_id TEXT,
  direction_done BOOLEAN NOT NULL DEFAULT FALSE,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
