-- 20260403190000_user_settings_reasoning_defaults.sql
-- Adds reasoning_defaults JSONB column to user_settings for per-model defaults.
-- Shape: { globalAutoEnable: boolean, models: Record<modelId, { effort: string, override: 'auto'|'force-on'|'force-off' }> }

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS reasoning_defaults JSONB NOT NULL DEFAULT '{"globalAutoEnable": false, "models": {}}';
