-- Model pricing table for dry-run cost estimation
CREATE TABLE IF NOT EXISTS model_pricing (
  model_id TEXT PRIMARY KEY,
  input_cost_per_1k REAL NOT NULL,
  output_cost_per_1k REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed with current Anthropic pricing (USD per 1K tokens)
INSERT OR IGNORE INTO model_pricing (model_id, input_cost_per_1k, output_cost_per_1k) VALUES
  ('claude-sonnet-4-5-20250929', 0.003, 0.015),
  ('claude-opus-4-6', 0.015, 0.075),
  ('claude-haiku-4-5-20251001', 0.0008, 0.004);
