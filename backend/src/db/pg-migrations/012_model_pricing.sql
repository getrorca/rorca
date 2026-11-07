-- 012_model_pricing.sql — Model pricing for dry-run cost estimation

CREATE TABLE IF NOT EXISTS model_pricing (
  model_id TEXT PRIMARY KEY,
  input_cost_per_1k REAL NOT NULL,
  output_cost_per_1k REAL NOT NULL,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  input_cost_per_1m REAL,
  output_cost_per_1m REAL,
  effective_date TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed with current Anthropic pricing (USD per 1K tokens)
INSERT INTO model_pricing (model_id, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m) VALUES
  ('claude-sonnet-4-5-20250929', 0.003, 0.015, 3.0, 15.0),
  ('claude-opus-4-6', 0.015, 0.075, 15.0, 75.0),
  ('claude-haiku-4-5-20251001', 0.0008, 0.004, 0.8, 4.0)
ON CONFLICT (model_id) DO NOTHING;
