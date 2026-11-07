-- Durable, operator-owned state for governed bug-bounty missions.
-- This migration is deliberately DDL-only: queue and pg-boss lifecycle stays with pg-boss.

CREATE TABLE bounty_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  release_mode TEXT NOT NULL DEFAULT 'sequential' CHECK (release_mode = 'sequential'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, name)
);

CREATE TABLE bounty_missions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','held','completed','cancelled')),
  epoch BIGINT NOT NULL DEFAULT 1 CHECK (epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id)
);

CREATE TABLE bounty_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0), body JSONB NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (workspace_id, id), UNIQUE (mission_id, revision),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE TABLE bounty_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL,
  epoch BIGINT NOT NULL CHECK (epoch > 0), input_identity TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, mission_id, id), UNIQUE (mission_id, epoch), UNIQUE (workspace_id, input_identity),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE TABLE bounty_work_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL,
  generation_id UUID NOT NULL, release_sequence BIGINT NOT NULL CHECK (release_sequence > 0), status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (workspace_id, id), UNIQUE (mission_id, release_sequence),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id, generation_id) REFERENCES bounty_generations(workspace_id, mission_id, id)
);
CREATE TABLE bounty_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, work_package_id UUID NOT NULL,
  attempt_no BIGINT NOT NULL CHECK (attempt_no > 0), idempotency_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (workspace_id, id), UNIQUE (work_package_id, attempt_no),
  UNIQUE (workspace_id, idempotency_key), FOREIGN KEY (workspace_id, work_package_id) REFERENCES bounty_work_packages(workspace_id, id)
);
CREATE TABLE bounty_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0), limit_cents BIGINT NOT NULL CHECK (limit_cents >= 0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (mission_id, revision), FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE TABLE bounty_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, work_package_id UUID NOT NULL,
  epoch BIGINT NOT NULL CHECK (epoch > 0), holder TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (work_package_id, epoch), FOREIGN KEY (workspace_id, work_package_id) REFERENCES bounty_work_packages(workspace_id, id)
);
CREATE TABLE bounty_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL,
  reason TEXT NOT NULL, released_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE TABLE bounty_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL, kind TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (workspace_id, id), UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE TABLE bounty_operation_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, operation_id UUID NOT NULL,
  receipt_identity TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, receipt_identity), FOREIGN KEY (workspace_id, operation_id) REFERENCES bounty_operations(workspace_id, id)
);
CREATE TABLE bounty_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL,
  evidence_identity TEXT NOT NULL, digest TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, evidence_identity), FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE TABLE bounty_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL,
  finding_identity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (workspace_id, finding_identity), FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE TABLE bounty_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, finding_id UUID NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0), body JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id), UNIQUE (finding_id, revision), FOREIGN KEY (workspace_id, finding_id) REFERENCES bounty_findings(workspace_id, id)
);
CREATE TABLE bounty_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, draft_id UUID NOT NULL,
  approval_identity TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (workspace_id, approval_identity),
  FOREIGN KEY (workspace_id, draft_id) REFERENCES bounty_drafts(workspace_id, id)
);
CREATE TABLE bounty_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL,
  event_identity TEXT NOT NULL, event_type TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (workspace_id, event_identity),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE TABLE bounty_application_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL, topic TEXT NOT NULL, payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key), FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);

-- Row updates are locked by PostgreSQL; revisions and mission epochs may only advance one step.
CREATE FUNCTION bounty_require_next_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'revision must advance by one' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_program_revision_monotonic BEFORE UPDATE OF revision ON bounty_programs
FOR EACH ROW EXECUTE FUNCTION bounty_require_next_update();

CREATE FUNCTION bounty_require_next_epoch_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.epoch <> OLD.epoch + 1 THEN RAISE EXCEPTION 'epoch must advance by one' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_mission_epoch_monotonic BEFORE UPDATE OF epoch ON bounty_missions
FOR EACH ROW EXECUTE FUNCTION bounty_require_next_epoch_update();

-- Serialize inserts per lineage and reject gaps or regressions, including concurrent writers.
CREATE FUNCTION bounty_require_next_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_value UUID; previous BIGINT; parent_column TEXT := TG_ARGV[0]; number_column TEXT := TG_ARGV[1];
BEGIN
  parent_value := (to_jsonb(NEW)->>parent_column)::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_NAME || ':' || parent_value::text, 0));
  EXECUTE format('SELECT max(%I) FROM %I WHERE %I = $1', number_column, TG_TABLE_NAME, parent_column) INTO previous USING parent_value;
  IF (to_jsonb(NEW)->>number_column)::bigint <> COALESCE(previous, 0) + 1 THEN
    RAISE EXCEPTION '% must be the next sequential value for %', number_column, parent_column USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bounty_contract_revision_sequence BEFORE INSERT ON bounty_contracts FOR EACH ROW EXECUTE FUNCTION bounty_require_next_number('mission_id','revision');
CREATE TRIGGER bounty_generation_epoch_sequence BEFORE INSERT ON bounty_generations FOR EACH ROW EXECUTE FUNCTION bounty_require_next_number('mission_id','epoch');
CREATE TRIGGER bounty_package_release_sequence BEFORE INSERT ON bounty_work_packages FOR EACH ROW EXECUTE FUNCTION bounty_require_next_number('mission_id','release_sequence');
CREATE TRIGGER bounty_attempt_number_sequence BEFORE INSERT ON bounty_attempts FOR EACH ROW EXECUTE FUNCTION bounty_require_next_number('work_package_id','attempt_no');
CREATE TRIGGER bounty_budget_revision_sequence BEFORE INSERT ON bounty_budgets FOR EACH ROW EXECUTE FUNCTION bounty_require_next_number('mission_id','revision');
CREATE TRIGGER bounty_lease_epoch_sequence BEFORE INSERT ON bounty_leases FOR EACH ROW EXECUTE FUNCTION bounty_require_next_number('work_package_id','epoch');
CREATE TRIGGER bounty_draft_revision_sequence BEFORE INSERT ON bounty_drafts FOR EACH ROW EXECUTE FUNCTION bounty_require_next_number('finding_id','revision');

CREATE FUNCTION bounty_reject_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
CREATE TRIGGER bounty_receipts_append_only BEFORE UPDATE OR DELETE ON bounty_operation_receipts FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_events_append_only BEFORE UPDATE OR DELETE ON bounty_events FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_evidence_append_only BEFORE UPDATE OR DELETE ON bounty_evidence FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
