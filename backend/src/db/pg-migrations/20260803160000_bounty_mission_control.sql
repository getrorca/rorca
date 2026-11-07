-- Durable pause/stop/kill authority, irreversible-send fencing, and restart reconciliation.
-- Application tables only: pg-boss owns every object in its schema.

ALTER TABLE bounty_missions DROP CONSTRAINT bounty_missions_state_check;
ALTER TABLE bounty_missions
  ADD CONSTRAINT bounty_missions_state_check
    CHECK (state IN ('draft','active','paused','held','completed','cancelled','stopped','killed')),
  ADD COLUMN control_reason TEXT,
  ADD COLUMN controlled_at TIMESTAMPTZ;

ALTER TABLE bounty_operations DROP CONSTRAINT bounty_operations_state_check;
ALTER TABLE bounty_operations
  ADD CONSTRAINT bounty_operations_state_check
    CHECK (state IN ('prepared','sent','observed','failed-before-send','cancelled-before-send','unknown')),
  ADD COLUMN authority_epoch BIGINT CHECK (authority_epoch IS NULL OR authority_epoch > 0);
CREATE INDEX bounty_operations_unsettled_idx
  ON bounty_operations(workspace_id, mission_id, state)
  WHERE kind='target.effect' AND state IN ('prepared','sent','unknown');

ALTER TABLE bounty_evidence ADD COLUMN authority_epoch BIGINT CHECK (authority_epoch IS NULL OR authority_epoch > 0);
ALTER TABLE bounty_findings ADD COLUMN authority_epoch BIGINT CHECK (authority_epoch IS NULL OR authority_epoch > 0);

-- Defense in depth: even a missed application check cannot admit stale evidence/findings.
CREATE FUNCTION bounty_require_current_authority_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_epoch BIGINT; active_state TEXT;
BEGIN
  SELECT epoch,state INTO active_epoch,active_state FROM bounty_missions
    WHERE workspace_id=NEW.workspace_id AND id=NEW.mission_id FOR SHARE;
  IF NEW.authority_epoch IS NULL OR NEW.authority_epoch <> active_epoch OR active_state <> 'active' THEN
    RAISE EXCEPTION 'stale mission authority epoch' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_evidence_epoch_fence BEFORE INSERT ON bounty_evidence
FOR EACH ROW EXECUTE FUNCTION bounty_require_current_authority_epoch();
CREATE TRIGGER bounty_findings_epoch_fence BEFORE INSERT ON bounty_findings
FOR EACH ROW EXECUTE FUNCTION bounty_require_current_authority_epoch();

ALTER TABLE bounty_application_outbox
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN cancellation_reason TEXT,
  ADD CONSTRAINT bounty_outbox_cancel_before_publish CHECK (cancelled_at IS NULL OR published_at IS NULL);

-- Revocations are append-only epoch facts. In-memory credentials, browser partitions,
-- callback allocations, jobs, and workers must all recheck this mission epoch.
CREATE TABLE bounty_authority_revocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  revoked_epoch BIGINT NOT NULL CHECK (revoked_epoch > 0),
  replacement_epoch BIGINT NOT NULL CHECK (replacement_epoch = revoked_epoch + 1),
  action TEXT NOT NULL CHECK (action IN ('pause','resume','stop','kill')),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, mission_id, replacement_epoch),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);

CREATE TABLE bounty_worker_processes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  authority_epoch BIGINT NOT NULL CHECK (authority_epoch > 0),
  process_group_id INTEGER NOT NULL CHECK (process_group_id > 1),
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','exited','term-requested','kill-requested')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at TIMESTAMPTZ,
  UNIQUE (workspace_id, attempt_id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES bounty_attempts(workspace_id, id)
);
CREATE INDEX bounty_worker_processes_live_idx
  ON bounty_worker_processes(workspace_id, mission_id, authority_epoch) WHERE exited_at IS NULL;

-- Stale browser/callback/adapter responses remain inspectable but have no authority.
CREATE TABLE bounty_stale_authority_inputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('job','worker','browser','callback','adapter-response','evidence','finding','completion')),
  source_identity TEXT NOT NULL,
  presented_epoch BIGINT NOT NULL CHECK (presented_epoch > 0),
  current_epoch BIGINT NOT NULL CHECK (current_epoch > presented_epoch),
  payload_hash TEXT CHECK (payload_hash IS NULL OR payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, mission_id, source, source_identity),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);

-- Named durable crash cuts make restart behavior observable and idempotent.
CREATE TABLE bounty_mission_crash_cuts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  boundary TEXT NOT NULL CHECK (boundary IN ('command','outbox','queue','lease','prepare','send','observation','evidence','completion')),
  boundary_identity TEXT NOT NULL,
  authority_epoch BIGINT NOT NULL CHECK (authority_epoch > 0),
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolution TEXT NOT NULL CHECK (resolution IN ('resume','discard-stale','cancel-prepared','hold-uncertain','quarantine','complete-once')),
  UNIQUE (workspace_id, mission_id, boundary, boundary_identity),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);

CREATE FUNCTION bounty_reject_control_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only control facts', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
CREATE TRIGGER bounty_authority_revocations_append_only BEFORE UPDATE OR DELETE ON bounty_authority_revocations
FOR EACH ROW EXECUTE FUNCTION bounty_reject_control_fact_mutation();
CREATE TRIGGER bounty_stale_authority_inputs_append_only BEFORE UPDATE OR DELETE ON bounty_stale_authority_inputs
FOR EACH ROW EXECUTE FUNCTION bounty_reject_control_fact_mutation();
CREATE TRIGGER bounty_mission_crash_cuts_append_only BEFORE UPDATE OR DELETE ON bounty_mission_crash_cuts
FOR EACH ROW EXECUTE FUNCTION bounty_reject_control_fact_mutation();
