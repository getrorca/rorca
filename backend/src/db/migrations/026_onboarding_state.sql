-- Onboarding wizard state persistence
-- Allows users to close browser and resume where they left off
CREATE TABLE IF NOT EXISTS onboarding_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
  current_step INTEGER NOT NULL DEFAULT 0,
  workspace_id TEXT,
  direction_done INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
