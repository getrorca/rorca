-- Additive transport for host-owned authority, not an authority issuer or scheduler.
-- Apply only through the normal migration owner. Runtime cannot publish authority.
SET LOCAL lock_timeout = '5s';
CREATE TABLE eco_host_records (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 kind TEXT NOT NULL CHECK(kind IN ('source','recipe','story-mapping','accepted-artifact')),
 record_key TEXT NOT NULL,
 canonical_bytes TEXT NOT NULL CHECK(octet_length(canonical_bytes)<=1048576),
 content_hash TEXT NOT NULL CHECK(content_hash='sha256:'||encode(digest(convert_to(canonical_bytes,'UTF8'),'sha256'),'hex')),
 PRIMARY KEY(workspace_id,kind,record_key),
 CHECK(jsonb_typeof(canonical_bytes::jsonb)='object')
);
CREATE TABLE eco_host_record_revocations (
 workspace_id TEXT NOT NULL,kind TEXT NOT NULL,record_key TEXT NOT NULL,reason TEXT NOT NULL CHECK(length(reason)>0),
 PRIMARY KEY(workspace_id,kind,record_key),
 FOREIGN KEY(workspace_id,kind,record_key) REFERENCES eco_host_records(workspace_id,kind,record_key)
);
CREATE FUNCTION lock_eco_host_record_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(NEW.workspace_id,NEW.kind,NEW.record_key)::text,0));
 RETURN NEW;
END $$;
CREATE TRIGGER eco_revocation_linearization BEFORE INSERT ON eco_host_record_revocations FOR EACH ROW EXECUTE FUNCTION lock_eco_host_record_revocation();
-- Existing host owner service imports/renews its current fence here. No runtime
-- lease issuance/renewal endpoint or independent watcher loop is introduced.
CREATE TABLE eco_watcher_owners (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),company_id TEXT NOT NULL,
 phase_work_id UUID NOT NULL,principal_id TEXT NOT NULL,owner_id TEXT NOT NULL,
 fence BIGINT NOT NULL CHECK(fence BETWEEN 1 AND 9007199254740991),
 expires_at TIMESTAMPTZ NOT NULL,revoked BOOLEAN NOT NULL DEFAULT FALSE,
 PRIMARY KEY(workspace_id,company_id,phase_work_id)
);
CREATE FUNCTION guard_eco_watcher_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.expires_at>clock_timestamp()+interval '60 seconds' THEN RAISE EXCEPTION 'Watcher lease exceeds 60 seconds'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.workspace_id,NEW.company_id,NEW.phase_work_id) IS DISTINCT FROM (OLD.workspace_id,OLD.company_id,OLD.phase_work_id)
   OR NEW.fence<OLD.fence
   OR (NEW.fence=OLD.fence AND ((NEW.principal_id,NEW.owner_id) IS DISTINCT FROM (OLD.principal_id,OLD.owner_id)
      OR OLD.revoked OR OLD.expires_at<=clock_timestamp())) THEN
   RAISE EXCEPTION 'Watcher owner requires increasing generation';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER eco_watcher_generation BEFORE INSERT OR UPDATE ON eco_watcher_owners FOR EACH ROW EXECUTE FUNCTION guard_eco_watcher_generation();
CREATE TABLE eco_managed_roots (
 workspace_id TEXT NOT NULL,phase_work_id UUID NOT NULL,revision BIGINT NOT NULL,
 phase_hash TEXT NOT NULL,company_id TEXT NOT NULL,principal_id TEXT NOT NULL,
 root_run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),current_run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
 deadline_at TIMESTAMPTZ NOT NULL,retry_limit INTEGER NOT NULL CHECK(retry_limit BETWEEN 0 AND 3),retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND retry_limit),
 tool_limit BIGINT NOT NULL,context_limit BIGINT NOT NULL,output_limit BIGINT NOT NULL,spend_limit BIGINT NOT NULL,
 used_tool_calls BIGINT NOT NULL DEFAULT 0 CHECK(used_tool_calls>=0 AND used_tool_calls<=tool_limit),
 used_context_tokens BIGINT NOT NULL DEFAULT 0 CHECK(used_context_tokens>=0 AND used_context_tokens<=context_limit),
 used_output_bytes BIGINT NOT NULL DEFAULT 0 CHECK(used_output_bytes>=0 AND used_output_bytes<=output_limit),
 used_spend_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK(used_spend_micro_usd>=0 AND used_spend_micro_usd<=spend_limit),
 PRIMARY KEY(workspace_id,phase_work_id,revision),
 FOREIGN KEY(workspace_id,phase_work_id,revision,phase_hash) REFERENCES eco_phase_work_revisions(workspace_id,phase_work_id,revision,content_hash)
);
CREATE TABLE eco_managed_run_bindings (
 run_id INTEGER PRIMARY KEY REFERENCES pipeline_runs(id),workspace_id TEXT NOT NULL,
 phase_work_id UUID NOT NULL,revision BIGINT NOT NULL,phase_hash TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,command_hash TEXT NOT NULL CHECK(command_hash ~ '^sha256:[0-9a-f]{64}$'),principal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,fence BIGINT NOT NULL,predecessor_run_id INTEGER REFERENCES pipeline_runs(id),
 UNIQUE(workspace_id,idempotency_key),UNIQUE(predecessor_run_id),
 FOREIGN KEY(workspace_id,phase_work_id,revision) REFERENCES eco_managed_roots(workspace_id,phase_work_id,revision)
);
CREATE TABLE eco_managed_usage_events (
 workspace_id TEXT NOT NULL,run_id INTEGER NOT NULL REFERENCES eco_managed_run_bindings(run_id),
 event_key TEXT NOT NULL,content_hash TEXT NOT NULL,canonical_bytes TEXT NOT NULL,
 PRIMARY KEY(workspace_id,run_id,event_key),
 CHECK(content_hash='sha256:'||encode(digest(convert_to(canonical_bytes,'UTF8'),'sha256'),'hex'))
);
CREATE FUNCTION guard_eco_managed_root() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Managed root is audit retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['current_run_id','retry_count','used_tool_calls','used_context_tokens','used_output_bytes','used_spend_micro_usd'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['current_run_id','retry_count','used_tool_calls','used_context_tokens','used_output_bytes','used_spend_micro_usd'])
  OR NEW.retry_count<OLD.retry_count OR NEW.retry_count>OLD.retry_count+1
  OR NEW.used_tool_calls<OLD.used_tool_calls OR NEW.used_context_tokens<OLD.used_context_tokens
  OR NEW.used_output_bytes<OLD.used_output_bytes OR NEW.used_spend_micro_usd<OLD.used_spend_micro_usd THEN
  RAISE EXCEPTION 'Managed original deadline, pins and cumulative budget cannot reset';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER eco_root_no_reset BEFORE UPDATE OR DELETE ON eco_managed_roots FOR EACH ROW EXECUTE FUNCTION guard_eco_managed_root();
-- Verify the existing canonical run/outbox association at transaction commit.
CREATE FUNCTION check_eco_managed_run_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pipeline_runs run JOIN pipeline_dispatch_publications publication ON publication.run_id=run.id
  WHERE run.id=NEW.run_id AND run.workspace_id=NEW.workspace_id AND publication.workspace_id=NEW.workspace_id
   AND run.idempotency_key=NEW.idempotency_key AND run.dispatch_request_hash=NEW.request_hash
   AND publication.request_hash=NEW.request_hash
   AND run.retried_from_run_id IS NOT DISTINCT FROM NEW.predecessor_run_id) THEN
  RAISE EXCEPTION 'Managed run lacks exact canonical run/outbox identity';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER eco_run_outbox_identity AFTER INSERT ON eco_managed_run_bindings
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_eco_managed_run_binding();
DO $$ DECLARE tab TEXT;runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE);
BEGIN
 IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'Explicit runtime database principal required'; END IF;
 FOREACH tab IN ARRAY ARRAY['eco_host_records','eco_host_record_revocations','eco_watcher_owners','eco_managed_roots','eco_managed_run_bindings','eco_managed_usage_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY eco_workspace ON %I USING(workspace_id=current_setting(''rorca.workspace_id'',TRUE)) WITH CHECK(workspace_id=current_setting(''rorca.workspace_id'',TRUE))',tab);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',tab);
  EXECUTE format('GRANT SELECT ON %I TO %I',tab,runtime_user);
  IF tab IN ('eco_managed_roots','eco_managed_run_bindings','eco_managed_usage_events') THEN
   EXECUTE format('GRANT INSERT ON %I TO %I',tab,runtime_user);
  END IF;
  IF tab<>'eco_watcher_owners' AND tab<>'eco_managed_roots' THEN
   EXECUTE format('CREATE TRIGGER eco_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_eco_phase_work_immutable()',tab);
  END IF;
  EXECUTE format('CREATE TRIGGER eco_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION guard_eco_phase_work_immutable()',tab);
 END LOOP;
 -- PostgreSQL requires UPDATE privilege for SELECT ... FOR SHARE. Only the
 -- immutable identity column is granted; generation trigger rejects changing it.
 EXECUTE format('GRANT UPDATE(phase_work_id) ON eco_watcher_owners TO %I',runtime_user);
 EXECUTE format('GRANT UPDATE(current_run_id,retry_count,used_tool_calls,used_context_tokens,used_output_bytes,used_spend_micro_usd) ON eco_managed_roots TO %I',runtime_user);
END $$;
