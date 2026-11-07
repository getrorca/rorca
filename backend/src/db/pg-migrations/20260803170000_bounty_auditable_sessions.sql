-- Ordered redacted mission sessions, authority-neutral intervention, lifecycle projections, and telemetry.
-- Authoritative events are immutable evidence. Every operator-facing lifecycle row is a separate projection.

CREATE TABLE bounty_session_stream_heads (
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  last_cursor BIGINT NOT NULL DEFAULT 0 CHECK (last_cursor >= 0),
  PRIMARY KEY (workspace_id, mission_id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);

CREATE TABLE bounty_authoritative_session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  cursor BIGINT NOT NULL CHECK (cursor > 0),
  event_identity TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN ('worker','validator','reporter','broker')),
  worker_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  redacted_payload JSONB NOT NULL CHECK (jsonb_typeof(redacted_payload) = 'object'),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^sha256:[0-9a-f]{64}$'),
  redaction_version TEXT NOT NULL DEFAULT 'bounty-redaction.v1',
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, event_identity),
  UNIQUE (workspace_id, mission_id, cursor),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE INDEX bounty_authoritative_events_resume_idx
  ON bounty_authoritative_session_events(workspace_id, mission_id, cursor);

-- Notes, leads, primitives, findings, and report drafts are independent channels.
-- `current_state` is a rebuildable projection; lifecycle facts below remain append-only.
CREATE TABLE bounty_activity_projections (
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('note','lead','primitive','finding','draft')),
  current_state TEXT NOT NULL,
  title TEXT NOT NULL,
  CHECK (
    (channel='note' AND current_state IN ('active','archived')) OR
    (channel='lead' AND current_state IN ('candidate','investigating','validated','rejected','promoted')) OR
    (channel='primitive' AND current_state IN ('candidate','verified','rejected','promoted')) OR
    (channel='finding' AND current_state IN ('draft','validating','confirmed','false-positive','oracle','reported')) OR
    (channel='draft' AND current_state IN ('drafting','review','approved','rejected','submitted'))
  ),
  redacted_body JSONB NOT NULL CHECK (jsonb_typeof(redacted_body) = 'object'),
  source_cursor BIGINT NOT NULL CHECK (source_cursor > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, artifact_id),
  UNIQUE (workspace_id, mission_id, channel, artifact_id),
  FOREIGN KEY (workspace_id, mission_id, source_cursor)
    REFERENCES bounty_authoritative_session_events(workspace_id, mission_id, cursor)
);
CREATE INDEX bounty_activity_projection_triage_idx
  ON bounty_activity_projections(workspace_id, mission_id, channel, current_state, updated_at DESC);

CREATE TABLE bounty_activity_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  event_identity TEXT NOT NULL,
  transition_hash TEXT NOT NULL CHECK (transition_hash ~ '^sha256:[0-9a-f]{64}$'),
  channel TEXT NOT NULL CHECK (channel IN ('note','lead','primitive','finding','draft')),
  previous_state TEXT,
  state TEXT NOT NULL,
  source_cursor BIGINT NOT NULL CHECK (source_cursor > 0),
  actor TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, event_identity),
  FOREIGN KEY (workspace_id, mission_id, channel, artifact_id)
    REFERENCES bounty_activity_projections(workspace_id, mission_id, channel, artifact_id),
  FOREIGN KEY (workspace_id, mission_id, source_cursor)
    REFERENCES bounty_authoritative_session_events(workspace_id, mission_id, cursor)
);
CREATE INDEX bounty_activity_lifecycle_order_idx
  ON bounty_activity_lifecycle_events(workspace_id, mission_id, occurred_at, id);

-- A nudge carries no authority fields. Its exact worker/checkpoint/epoch binding is immutable,
-- and consumers must recheck both expiry and current mission epoch before delivery.
ALTER TABLE bounty_worker_processes
  ADD CONSTRAINT bounty_worker_processes_workspace_identity UNIQUE (workspace_id, id);
CREATE TABLE bounty_checkpoint_nudges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  mission_epoch BIGINT NOT NULL CHECK (mission_epoch > 0),
  operator_id TEXT NOT NULL,
  worker_id UUID NOT NULL,
  checkpoint_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  redacted_text TEXT NOT NULL CHECK (length(redacted_text) BETWEEN 1 AND 4000),
  text_hash TEXT NOT NULL CHECK (text_hash ~ '^sha256:[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  UNIQUE (workspace_id, operator_id, idempotency_key),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, worker_id) REFERENCES bounty_worker_processes(workspace_id, id),
  FOREIGN KEY (workspace_id, checkpoint_id) REFERENCES bounty_continuation_checkpoints(workspace_id, id)
);
CREATE INDEX bounty_checkpoint_nudges_delivery_idx
  ON bounty_checkpoint_nudges(workspace_id, mission_id, worker_id, checkpoint_id, expires_at);

-- Every required accounting dimension is mandatory. Counters are additive immutable facts.
CREATE TABLE bounty_activity_telemetry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  event_identity TEXT NOT NULL,
  metric_hash TEXT NOT NULL CHECK (metric_hash ~ '^sha256:[0-9a-f]{64}$'),
  worker_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  activity TEXT NOT NULL,
  skill TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reasoning_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  context_tokens BIGINT NOT NULL DEFAULT 0 CHECK (context_tokens >= 0),
  cache_hits BIGINT NOT NULL DEFAULT 0 CHECK (cache_hits >= 0),
  cache_hit_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_hit_tokens >= 0),
  tool_calls BIGINT NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  effect_calls BIGINT NOT NULL DEFAULT 0 CHECK (effect_calls >= 0),
  requests BIGINT NOT NULL DEFAULT 0 CHECK (requests >= 0),
  callbacks BIGINT NOT NULL DEFAULT 0 CHECK (callbacks >= 0),
  wall_time_ms BIGINT NOT NULL DEFAULT 0 CHECK (wall_time_ms >= 0),
  cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (cost_microusd >= 0),
  auth_loop_requests BIGINT NOT NULL DEFAULT 0 CHECK (auth_loop_requests >= 0),
  auth_loop_cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (auth_loop_cost_microusd >= 0),
  false_positive_outcomes BIGINT NOT NULL DEFAULT 0 CHECK (false_positive_outcomes >= 0),
  oracle_outcomes BIGINT NOT NULL DEFAULT 0 CHECK (oracle_outcomes >= 0),
  high_confidence_alerts BIGINT NOT NULL DEFAULT 0 CHECK (high_confidence_alerts >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, event_identity),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);
CREATE INDEX bounty_activity_telemetry_dimensions_idx
  ON bounty_activity_telemetry(workspace_id, mission_id, worker_id, phase, activity, skill, model, occurred_at);

-- Alerts are a fast, rebuildable triage projection with stable identities; evidence remains in the stream.
CREATE TABLE bounty_alert_projections (
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  alert_id UUID NOT NULL,
  source_cursor BIGINT NOT NULL CHECK (source_cursor > 0),
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  triage_state TEXT NOT NULL DEFAULT 'new' CHECK (triage_state IN ('new','triaged','escalated','dismissed','resolved')),
  redacted_summary TEXT NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('confirmed','false-positive','oracle')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, alert_id),
  FOREIGN KEY (workspace_id, mission_id, source_cursor)
    REFERENCES bounty_authoritative_session_events(workspace_id, mission_id, cursor)
);
CREATE INDEX bounty_alert_triage_queue_idx
  ON bounty_alert_projections(workspace_id, mission_id, triage_state, confidence DESC, source_cursor ASC);

CREATE FUNCTION bounty_require_legal_activity_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel <> OLD.channel OR NOT (
    (OLD.channel='note' AND (OLD.current_state,NEW.current_state) IN (('active','archived'))) OR
    (OLD.channel='lead' AND (OLD.current_state,NEW.current_state) IN (('candidate','investigating'),('candidate','rejected'),('investigating','validated'),('investigating','rejected'),('validated','promoted'))) OR
    (OLD.channel='primitive' AND (OLD.current_state,NEW.current_state) IN (('candidate','verified'),('candidate','rejected'),('verified','promoted'))) OR
    (OLD.channel='finding' AND (OLD.current_state,NEW.current_state) IN (('draft','validating'),('validating','confirmed'),('validating','false-positive'),('validating','oracle'),('confirmed','reported'))) OR
    (OLD.channel='draft' AND (OLD.current_state,NEW.current_state) IN (('drafting','review'),('review','approved'),('review','rejected'),('rejected','drafting'),('approved','submitted')))
  ) THEN
    RAISE EXCEPTION 'illegal % lifecycle transition: % -> %', OLD.channel, OLD.current_state, NEW.current_state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_activity_projection_legal_transition BEFORE UPDATE OF current_state ON bounty_activity_projections
FOR EACH ROW WHEN (OLD.current_state IS DISTINCT FROM NEW.current_state) EXECUTE FUNCTION bounty_require_legal_activity_transition();

CREATE FUNCTION bounty_require_legal_alert_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.triage_state,NEW.triage_state) NOT IN (
    ('new','triaged'),('new','escalated'),('new','dismissed'),
    ('triaged','escalated'),('triaged','dismissed'),('triaged','resolved'),
    ('escalated','resolved'),('escalated','dismissed')
  ) THEN
    RAISE EXCEPTION 'illegal alert transition: % -> %', OLD.triage_state, NEW.triage_state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_alert_projection_legal_transition BEFORE UPDATE OF triage_state ON bounty_alert_projections
FOR EACH ROW WHEN (OLD.triage_state IS DISTINCT FROM NEW.triage_state) EXECUTE FUNCTION bounty_require_legal_alert_transition();

CREATE FUNCTION bounty_reject_session_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable mission facts', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
CREATE TRIGGER bounty_authoritative_events_immutable BEFORE UPDATE OR DELETE ON bounty_authoritative_session_events FOR EACH ROW EXECUTE FUNCTION bounty_reject_session_fact_mutation();
CREATE TRIGGER bounty_activity_lifecycle_immutable BEFORE UPDATE OR DELETE ON bounty_activity_lifecycle_events FOR EACH ROW EXECUTE FUNCTION bounty_reject_session_fact_mutation();
CREATE TRIGGER bounty_checkpoint_nudges_immutable BEFORE UPDATE OR DELETE ON bounty_checkpoint_nudges FOR EACH ROW EXECUTE FUNCTION bounty_reject_session_fact_mutation();
CREATE TRIGGER bounty_activity_telemetry_immutable BEFORE UPDATE OR DELETE ON bounty_activity_telemetry FOR EACH ROW EXECUTE FUNCTION bounty_reject_session_fact_mutation();
