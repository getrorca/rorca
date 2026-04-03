-- OpenRouter provider routing preferences per model.
-- Allows users to control which infrastructure providers handle requests
-- (e.g., ignore Ambient for GLM-5 to get full 200K context window).

SET search_path TO rorca, public;

CREATE TABLE IF NOT EXISTS openrouter_provider_prefs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id      TEXT NOT NULL,
  pref_order    TEXT[],           -- preferred provider order (e.g. '{DeepInfra,SiliconFlow}')
  ignore_list   TEXT[],           -- providers to skip (e.g. '{Ambient}')
  allow_fallbacks BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(model_id)
);

CREATE INDEX IF NOT EXISTS idx_or_provider_prefs_model ON openrouter_provider_prefs (model_id);

-- Restore search_path for migration runner (pg-index.ts expects public)
SET search_path TO public;
