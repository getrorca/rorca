-- 20260817120000_lifecycle_policy_approval_plan_binding_reconciliation.sql
-- Governed reconciliation for policy approvals created before the compiled-plan
-- identity columns existed (migration 20260812120000_lifecycle_policy_subjects).
--
-- Problem: ssdlc_decisions rows of type policy_approval written before the
-- binding columns were populated carry compiled_plan_id = NULL and plan_id = NULL.
-- The evaluator treats them as plan_identity_mismatch (stale), while the
-- append-only ledger guard refuses to update them and the full unique index on
-- (workspace_id, source_request_id) blocks a replacement with the same key.
-- persistPolicyDecision's ON CONFLICT DO NOTHING + request_hash replay then
-- returns 'replayed' forever without ever binding the row to the current plan,
-- so pre-execution gates stay stale and dispatch fails with
-- LIFECYCLE_PRE_EXECUTION_BLOCKED.
--
-- Repair: for every stale unbound policy approval whose exact subject matches
-- the CURRENT validated compiled plan's spec hash, mint a NEW GENERATION
-- approval bound to that plan (compiled_plan_id + plan_id set) under a FRESH
-- source_request_id (":reconciled" suffix) that cannot collide with the
-- immutable historical row. request_hash is reproduced exactly as
-- persistPolicyDecision computes it (verified: identical inputs → identical
-- digest), so future replays of this generation key are stable.
--
-- runPgMigrations supplies the transaction boundary for this file.

INSERT INTO rorca.ssdlc_decisions (
  workspace_id, spec_slug, spec_version, run_id, phase_id, gate_id, decision_type,
  rationale, subject_type, subject_value, policy_version, policy_reference,
  policy_authorized, principal_type, principal_id, principal_display_label, actor,
  source_request_id, source_channel, scope_key, request_hash, compiled_plan_id, plan_id
)
SELECT
  stale.workspace_id,
  stale.spec_slug,
  plan.spec_version,
  NULL,
  stale.phase_id,
  stale.gate_id,
  'policy_approval',
  'Current exact-subject evidence satisfies this compiled policy gate.',
  stale.subject_type,
  stale.subject_value,
  plan.plan_json->>'policyVersion',
  (plan.plan_json->>'policyVersion') || ':' || (plan.plan_json->>'planId') || ':'
    || plan.id::text || ':' || (plan.plan_json->>'inputHash') || ':' || stale.gate_id,
  TRUE,
  'internal_service', 'lifecycle-policy-verifier', 'Rorca Lifecycle Policy Verifier',
  'lifecycle-policy-verifier',
  'lifecycle-policy:' || plan.id::text || ':' || stale.gate_id || ':' || stale.subject_type
    || ':' || stale.subject_value || ':plan:reconciled',
  'internal',
  stale.spec_slug || '|' || stale.phase_id || '|' || stale.gate_id || '|*|*',
  stale.request_hash,
  plan.id::bigint,
  plan.plan_json->>'planId'
FROM rorca.ssdlc_decisions stale
JOIN rorca.ssdlc_compiled_plans plan
  ON plan.workspace_id = stale.workspace_id
 AND plan.spec_slug = stale.spec_slug
 AND plan.is_current = TRUE
 AND plan.validation_status = 'validated'
WHERE stale.decision_type = 'policy_approval'
  AND stale.revoked_at IS NULL
  AND stale.compiled_plan_id IS NULL
  AND stale.plan_id IS NULL
  AND stale.subject_type = 'spec_hash'
  AND stale.subject_value = plan.provenance_json->>'specHash'
  AND stale.source_request_id = 'lifecycle-policy:' || plan.id::text || ':' || stale.gate_id
    || ':spec_hash:' || stale.subject_value || ':plan'
  AND NOT EXISTS (
    SELECT 1 FROM rorca.ssdlc_decisions existing
    WHERE existing.workspace_id = stale.workspace_id
      AND existing.spec_slug = stale.spec_slug
      AND existing.compiled_plan_id = plan.id
      AND existing.decision_type = 'policy_approval'
      AND existing.revoked_at IS NULL
  )
ON CONFLICT (workspace_id, source_request_id) DO NOTHING;
