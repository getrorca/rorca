-- 20260718120000_story_result_accounting_identity.sql
-- F-04: bind each canonical accounting projection to exactly one story result
-- and retain the immutable commit/accounting provenance used for idempotency.

ALTER TABLE story_results
  ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS integrated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS commit_sha TEXT,
  ADD COLUMN IF NOT EXISTS commit_message TEXT,
  ADD COLUMN IF NOT EXISTS commit_author TEXT,
  ADD COLUMN IF NOT EXISTS commit_branch TEXT,
  ADD COLUMN IF NOT EXISTS commit_observed_source TEXT,
  ADD COLUMN IF NOT EXISTS accounting_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS accounting_model TEXT,
  ADD COLUMN IF NOT EXISTS accounting_input_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS accounting_output_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS accounting_reasoning_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS accounting_cost_usd NUMERIC(18,6),
  ADD COLUMN IF NOT EXISTS accounting_cost_source TEXT,
  ADD COLUMN IF NOT EXISTS accounting_input_rate NUMERIC(18,9),
  ADD COLUMN IF NOT EXISTS accounting_output_rate NUMERIC(18,9),
  ADD COLUMN IF NOT EXISTS finished_at_source TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS story_result_id INTEGER,
  ADD COLUMN IF NOT EXISTS cost_source TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS input_cost_per_1k NUMERIC(18,9),
  ADD COLUMN IF NOT EXISTS output_cost_per_1k NUMERIC(18,9);

-- Upgrade-safe legacy backfill: bind only unambiguous one-result/one-usage
-- pairs. Ambiguous historical telemetry remains deliberately unbound and can
-- never satisfy canonical result completeness checks.
WITH one_to_one AS (
  SELECT MIN(sr.id) AS story_result_id, MIN(tu.id) AS token_usage_id
  FROM story_results sr
  JOIN token_usage tu
    ON tu.run_id = sr.run_id AND tu.story_id = sr.story_id
  WHERE tu.story_result_id IS NULL
  GROUP BY sr.run_id, sr.story_id
  HAVING COUNT(DISTINCT sr.id) = 1 AND COUNT(DISTINCT tu.id) = 1
)
UPDATE token_usage tu
SET story_result_id = pair.story_result_id
FROM one_to_one pair
WHERE tu.id = pair.token_usage_id AND tu.story_result_id IS NULL;

UPDATE story_results sr
SET reasoning_tokens = COALESCE(sr.reasoning_tokens, tu.reasoning_tokens),
    accounting_required = TRUE,
    accounting_model = tu.model,
    accounting_input_tokens = tu.input_tokens,
    accounting_output_tokens = tu.output_tokens,
    accounting_reasoning_tokens = tu.reasoning_tokens,
    accounting_cost_usd = ROUND(tu.cost_usd::numeric, 6),
    accounting_cost_source = tu.cost_source,
    accounting_input_rate = tu.input_cost_per_1k,
    accounting_output_rate = tu.output_cost_per_1k
FROM token_usage tu
WHERE tu.story_result_id = sr.id;

-- Backfill exact integrated identity only where the historical projection is
-- unambiguous. Legitimate non-integrated pass/fail/skip/excluded rows stay false.
WITH one_commit AS (
  SELECT sr.id AS story_result_id,
         MIN(sc.commit_sha) AS commit_sha,
         MIN(sc.commit_message) AS commit_message,
         MIN(sc.author) AS commit_author,
         MIN(sc.branch_name) AS commit_branch,
         MIN(sc.observed_source) AS commit_observed_source
  FROM story_results sr
  JOIN story_commits sc
    ON sc.run_id = sr.run_id
   AND sc.story_id = sr.story_id
   AND sc.spec_id = sr.spec_id
  WHERE sr.status = 'pass'
    AND sc.commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND NULLIF(sc.commit_message, '') IS NOT NULL
    AND NULLIF(sc.author, '') IS NOT NULL
    AND NULLIF(sc.branch_name, '') IS NOT NULL
    AND NULLIF(sc.observed_source, '') IS NOT NULL
  GROUP BY sr.id
  HAVING COUNT(sc.id) = 1
)
UPDATE story_results sr
SET integrated = TRUE,
    commit_sha = source.commit_sha,
    commit_message = source.commit_message,
    commit_author = source.commit_author,
    commit_branch = source.commit_branch,
    commit_observed_source = source.commit_observed_source
FROM one_commit source
WHERE sr.id = source.story_result_id;

ALTER TABLE token_usage
  DROP CONSTRAINT IF EXISTS token_usage_story_result_fk,
  ADD CONSTRAINT token_usage_story_result_fk
    FOREIGN KEY (story_result_id) REFERENCES story_results(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_token_usage_story_result
  ON token_usage (story_result_id)
  WHERE story_result_id IS NOT NULL;

ALTER TABLE story_results
  DROP CONSTRAINT IF EXISTS story_results_integrated_commit_ck,
  ADD CONSTRAINT story_results_integrated_commit_ck CHECK (
    NOT integrated OR (
      status = 'pass'
      AND commit_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
      AND NULLIF(commit_message, '') IS NOT NULL
      AND NULLIF(commit_author, '') IS NOT NULL
      AND NULLIF(commit_branch, '') IS NOT NULL
      AND NULLIF(commit_observed_source, '') IS NOT NULL
    )
  ),
  DROP CONSTRAINT IF EXISTS story_results_accounting_projection_ck,
  ADD CONSTRAINT story_results_accounting_projection_ck CHECK (
    (NOT accounting_required AND accounting_model IS NULL
      AND accounting_input_tokens IS NULL AND accounting_output_tokens IS NULL
      AND accounting_reasoning_tokens IS NULL AND accounting_cost_usd IS NULL
      AND accounting_cost_source IS NULL AND accounting_input_rate IS NULL
      AND accounting_output_rate IS NULL)
    OR
    (accounting_required AND NULLIF(accounting_model, '') IS NOT NULL
      AND accounting_input_tokens >= 0 AND accounting_output_tokens >= 0
      AND accounting_reasoning_tokens >= 0 AND accounting_cost_usd >= 0
      AND accounting_cost_source IN ('explicit', 'derived', 'legacy'))
  ),
  DROP CONSTRAINT IF EXISTS story_results_finished_at_source_ck,
  ADD CONSTRAINT story_results_finished_at_source_ck
    CHECK (finished_at_source IN ('database', 'observed', 'legacy'));

CREATE OR REPLACE FUNCTION reject_token_usage_result_rebind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.story_result_id IS NOT NULL
     AND NEW.story_result_id IS DISTINCT FROM OLD.story_result_id THEN
    RAISE EXCEPTION 'token_usage.story_result_id is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_token_usage_result_rebind ON token_usage;
CREATE TRIGGER trg_token_usage_result_rebind
BEFORE UPDATE OF story_result_id ON token_usage
FOR EACH ROW EXECUTE FUNCTION reject_token_usage_result_rebind();
