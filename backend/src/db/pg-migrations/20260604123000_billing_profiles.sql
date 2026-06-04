-- FIN-001: Canonical billing-profile data model.
--
-- A billing profile describes HOW a provider/model is paid for, independent of
-- per-token pricing (which lives in model_pricing). This is the first-class way
-- to declare whether a provider/model is metered API, a flat subscription, a
-- managed/hosted plan, free/local, or unknown — plus how a subscription's monthly
-- cost should be allocated across runs, the effective date window the profile is
-- valid for, the workspace it scopes to, and whether it is currently enabled.
--
-- NOTE: This migration intentionally does NOT touch any pgboss.* tables.
-- Numbered placeholders ($1, $2, ...) are used by all consuming code.

CREATE TABLE IF NOT EXISTS billing_profiles (
  id BIGSERIAL PRIMARY KEY,

  -- Workspace scope: NULL means a global/default profile that applies to every
  -- workspace; a non-NULL workspace_id scopes the profile to a single workspace.
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Provider/model matching. provider is required (e.g. 'anthropic', 'openai').
  -- model_pattern is an optional glob-ish match (e.g. 'claude-opus-*'); NULL means
  -- the profile applies to the whole provider.
  provider TEXT NOT NULL,
  model_pattern TEXT,

  -- Billing mode classification.
  billing_mode TEXT NOT NULL CHECK (billing_mode IN (
    'metered_api', 'subscription', 'managed', 'free_local', 'unknown'
  )),

  -- Subscription economics. Only meaningful when billing_mode = 'subscription'
  -- (and optionally 'managed'). NUMERIC to avoid float drift on money.
  monthly_cost_usd NUMERIC(12, 2),

  -- How a flat subscription cost is spread across runs for per-run attribution.
  --   none        = do not attribute subscription cost to runs
  --   even        = split evenly across runs in the period
  --   by_tokens   = weight attribution by token volume
  --   by_runs     = weight attribution by run count
  allocation_basis TEXT NOT NULL DEFAULT 'none' CHECK (allocation_basis IN (
    'none', 'even', 'by_tokens', 'by_runs'
  )),

  -- Effective date window the profile is valid for. effective_from is required;
  -- effective_to NULL means open-ended (still in effect).
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,

  notes TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A subscription must declare a monthly cost; non-subscription modes must not.
  CHECK (
    (billing_mode = 'subscription' AND monthly_cost_usd IS NOT NULL AND monthly_cost_usd >= 0)
    OR (billing_mode <> 'subscription')
  ),

  -- Monetary values, when present, are non-negative.
  CHECK (monthly_cost_usd IS NULL OR monthly_cost_usd >= 0),

  -- Window must be coherent: end strictly after start when bounded.
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- Primary lookup: resolve the active profile for a (workspace, provider, model)
-- at a point in time.
CREATE INDEX IF NOT EXISTS idx_billing_profiles_lookup
  ON billing_profiles (workspace_id, provider, enabled, effective_from DESC);

CREATE INDEX IF NOT EXISTS idx_billing_profiles_provider
  ON billing_profiles (provider, enabled);
