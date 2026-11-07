-- 20260403000000_add_reasoning_tokens.sql
-- Add reasoning_tokens column to token_usage for tracking thinking/reasoning token spend separately.
-- Providers that report reasoning tokens:
--   Anthropic: thinking block token count (extended thinking enabled)
--   OpenAI: usage.completion_tokens_details.reasoning_tokens (o-series models)

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER NOT NULL DEFAULT 0;
