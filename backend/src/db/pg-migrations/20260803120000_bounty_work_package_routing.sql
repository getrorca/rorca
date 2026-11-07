-- Immutable deterministic route decisions for governed bounty work packages.
-- Route bodies separate availability, routing, authorization, and actual effects.

ALTER TABLE bounty_work_packages
  ADD COLUMN route_input_hash TEXT,
  ADD COLUMN route_hash TEXT,
  ADD COLUMN route_policy_hash TEXT,
  ADD COLUMN objective_id TEXT,
  ADD COLUMN objective_class TEXT,
  ADD COLUMN role_name TEXT,
  ADD COLUMN context_tokens INTEGER,
  ADD COLUMN model_tier TEXT,
  ADD COLUMN selected_hashes JSONB,
  ADD COLUMN omissions JSONB,
  ADD COLUMN reason_codes JSONB,
  ADD COLUMN route_body JSONB,
  ADD CONSTRAINT bounty_work_packages_route_input_hash_format CHECK (route_input_hash IS NULL OR route_input_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT bounty_work_packages_route_hash_format CHECK (route_hash IS NULL OR route_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT bounty_work_packages_route_policy_hash_format CHECK (route_policy_hash IS NULL OR route_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT bounty_work_packages_objective_class CHECK (objective_class IS NULL OR objective_class IN (
    'program-intake','scope-validation','asset-inventory','surface-enumeration',
    'whitebox-focused-review','whitebox-synthesis','authentication-testing',
    'authorization-testing','input-validation-testing','business-logic-testing',
    'configuration-testing','dependency-analysis','active-verification',
    'evidence-correlation','finding-drafting','mission-synthesis'
  )),
  ADD CONSTRAINT bounty_work_packages_model_tier CHECK (model_tier IS NULL OR model_tier IN ('standard','advanced')),
  ADD CONSTRAINT bounty_work_packages_context_tokens CHECK (context_tokens IS NULL OR context_tokens BETWEEN 0 AND 40000),
  ADD CONSTRAINT bounty_work_packages_selected_hashes_array CHECK (selected_hashes IS NULL OR jsonb_typeof(selected_hashes) = 'array'),
  ADD CONSTRAINT bounty_work_packages_omissions_array CHECK (omissions IS NULL OR jsonb_typeof(omissions) = 'array'),
  ADD CONSTRAINT bounty_work_packages_reason_codes_array CHECK (reason_codes IS NULL OR jsonb_typeof(reason_codes) = 'array'),
  ADD CONSTRAINT bounty_work_packages_route_body_object CHECK (route_body IS NULL OR jsonb_typeof(route_body) = 'object'),
  ADD CONSTRAINT bounty_work_packages_route_columns_together CHECK (
    (route_input_hash IS NULL AND route_hash IS NULL AND route_policy_hash IS NULL AND route_body IS NULL)
    OR
    (route_input_hash IS NOT NULL AND route_hash IS NOT NULL AND route_policy_hash IS NOT NULL
      AND package_hash IS NOT NULL AND objective_id IS NOT NULL AND objective_class IS NOT NULL
      AND role_name IS NOT NULL AND context_tokens IS NOT NULL AND model_tier IS NOT NULL
      AND selected_hashes IS NOT NULL AND omissions IS NOT NULL AND reason_codes IS NOT NULL
      AND route_body IS NOT NULL)
  );

CREATE INDEX bounty_work_packages_route_lookup_idx
  ON bounty_work_packages(workspace_id, mission_id, route_input_hash, release_sequence)
  WHERE route_input_hash IS NOT NULL;

-- Every authorized routing attempt is retained, including blocked decisions that
-- correctly create no work package. The deterministic body carries separated
-- reports and telemetry, while actor/purpose/epoch preserve operator provenance.
CREATE TABLE bounty_work_package_route_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  mission_epoch BIGINT NOT NULL CHECK (mission_epoch > 0),
  route_input_hash TEXT NOT NULL CHECK (route_input_hash ~ '^sha256:[0-9a-f]{64}$'),
  route_hash TEXT NOT NULL CHECK (route_hash ~ '^sha256:[0-9a-f]{64}$'),
  route_policy_hash TEXT NOT NULL CHECK (route_policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  can_create BOOLEAN NOT NULL,
  reason_codes JSONB NOT NULL CHECK (jsonb_typeof(reason_codes) = 'array'),
  omissions JSONB NOT NULL CHECK (jsonb_typeof(omissions) = 'array'),
  reports JSONB NOT NULL CHECK (jsonb_typeof(reports) = 'object'),
  telemetry JSONB NOT NULL CHECK (jsonb_typeof(telemetry) = 'object'),
  decision_body JSONB NOT NULL CHECK (jsonb_typeof(decision_body) = 'object'),
  actor TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, mission_id, route_input_hash),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);

CREATE FUNCTION bounty_guard_work_package_route_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'work package route decision is immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER bounty_work_package_route_decision_guard BEFORE UPDATE OR DELETE ON bounty_work_package_route_decisions
FOR EACH ROW EXECUTE FUNCTION bounty_guard_work_package_route_decision();

-- Execution may advance status, but no route decision or selected hash may change.
CREATE FUNCTION bounty_guard_work_package_route_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.route_input_hash IS NOT NULL AND (
    NEW.route_input_hash, NEW.route_hash, NEW.route_policy_hash, NEW.package_hash,
    NEW.objective_id, NEW.objective_class, NEW.role_name, NEW.context_tokens,
    NEW.model_tier, NEW.selected_hashes, NEW.omissions, NEW.reason_codes, NEW.route_body
  ) IS DISTINCT FROM (
    OLD.route_input_hash, OLD.route_hash, OLD.route_policy_hash, OLD.package_hash,
    OLD.objective_id, OLD.objective_class, OLD.role_name, OLD.context_tokens,
    OLD.model_tier, OLD.selected_hashes, OLD.omissions, OLD.reason_codes, OLD.route_body
  ) THEN
    RAISE EXCEPTION 'work package route is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_work_package_route_update_guard BEFORE UPDATE ON bounty_work_packages
FOR EACH ROW EXECUTE FUNCTION bounty_guard_work_package_route_update();
