-- Governed retry recovery: allow an operator-authorized re-preparation of a
-- preview that was refused by a transient worker/engine guard (worker death,
-- pre-fix worktree guard, stale dispatched preview) rather than by evidence.
--
-- The preview row is immutable after `refused` by default (terminal retry
-- preview evidence). A worker or engine that dies mid-retry can leave the
-- preview refused while the underlying cause (worktree, story revision, spec)
-- has since been resolved, permanently blocking any new dispatch for the
-- original run because the retry preview hash is deterministic.
--
-- This migration permits `refused -> approved` (and `refused -> preparing`)
-- ONLY when the session explicitly enables recovery:
--   SET rorca.retry_recovery = 'on'
-- The application sets that GUC only after re-validating worktree preflight,
-- exact executable story revision authority, and lifecycle dispatch readiness,
-- so the refusal cause is proven resolved before the transition is allowed.
-- Refusals caused by genuine evidence conflicts remain immutable.

CREATE OR REPLACE FUNCTION rorca.enforce_pipeline_retry_preview_transition()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
DECLARE
  status_allowed BOOLEAN;
  preparation_allowed BOOLEAN;
  recovery_enabled BOOLEAN := current_setting('rorca.retry_recovery', TRUE) = 'on';
BEGIN
  status_allowed := NEW.status = OLD.status OR CASE OLD.status
    WHEN 'previewed' THEN NEW.status IN ('approved', 'cancelled', 'refused')
    WHEN 'approved' THEN NEW.status IN ('dispatched', 'cancelled', 'refused')
    WHEN 'dispatched' THEN NEW.status IN ('cancelled', 'refused')
    WHEN 'refused' THEN recovery_enabled AND NEW.status = 'approved'
    ELSE FALSE
  END;
  IF NOT status_allowed THEN
    RAISE EXCEPTION 'illegal retry preview transition: % -> %', OLD.status, NEW.status;
  END IF;

  preparation_allowed := NEW.preparation_state = OLD.preparation_state OR CASE OLD.preparation_state
    WHEN 'unowned' THEN NEW.preparation_state IN ('preparing', 'cancelled', 'refused')
    WHEN 'preparing' THEN NEW.preparation_state IN ('artifacts_ready', 'cancelled', 'refused')
    WHEN 'artifacts_ready' THEN NEW.preparation_state IN ('hooks_running', 'cancelled', 'refused')
    WHEN 'hooks_running' THEN NEW.preparation_state IN ('hooks_passed', 'cancelled', 'refused')
    WHEN 'hooks_passed' THEN NEW.preparation_state IN ('manifests_ready', 'cancelled', 'refused')
    WHEN 'manifests_ready' THEN NEW.preparation_state IN ('outbox_ready', 'cancelled', 'refused')
    WHEN 'outbox_ready' THEN NEW.preparation_state IN ('published', 'cancelled', 'refused')
    WHEN 'published' THEN NEW.preparation_state IN ('cancelled', 'refused')
    WHEN 'refused' THEN recovery_enabled AND NEW.preparation_state IN ('preparing', 'unowned')
    ELSE FALSE
  END;
  IF NOT preparation_allowed THEN
    RAISE EXCEPTION 'illegal retry preparation transition: % -> %', OLD.preparation_state, NEW.preparation_state;
  END IF;

  -- A refused row being recovered is not terminal evidence anymore; the
  -- operator-authorized transition above is the only way out of refusal.
  IF OLD.status IN ('cancelled', 'refused') THEN
    IF NEW.status = OLD.status AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'terminal retry preview evidence is immutable';
    END IF;
    IF NEW.status = OLD.status THEN
      RETURN OLD;
    END IF;
  END IF;
  NEW.preparation_updated_at := NOW();
  RETURN NEW;
END $function$;
