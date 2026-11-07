-- Wave 2 independent-review remediation. This migration extends, rather than
-- rewrites, the rejected 148/149 contracts so f757 and 149 upgrades remain
-- independently testable.

-- Transport evidence is meaningful only in the exact pg-boss schema that
-- published the job. Both application ownership rows persist that identity.
ALTER TABLE rorca.spec_jobs
  ADD COLUMN IF NOT EXISTS transport_schema TEXT;
ALTER TABLE rorca.spec_post_save_workflow_stages
  ADD COLUMN IF NOT EXISTS transport_schema TEXT;
ALTER TABLE rorca.spec_jobs
  DROP CONSTRAINT IF EXISTS spec_jobs_transport_schema_ck;
ALTER TABLE rorca.spec_jobs
  ADD CONSTRAINT spec_jobs_transport_schema_ck CHECK (
    transport_schema IS NULL OR transport_schema ~ '^pgboss(?:_[a-z0-9_]{1,48})?$'
  );
ALTER TABLE rorca.spec_post_save_workflow_stages
  DROP CONSTRAINT IF EXISTS spec_post_save_stages_transport_schema_ck;
ALTER TABLE rorca.spec_post_save_workflow_stages
  ADD CONSTRAINT spec_post_save_stages_transport_schema_ck CHECK (
    transport_schema IS NULL OR transport_schema ~ '^pgboss(?:_[a-z0-9_]{1,48})?$'
  );

-- One durable bounded response per actor/authority/key. Raw idempotency keys are
-- never retained. Exact replay reads this row; changed replay gets one immutable
-- conflict audit, not one row per request.
CREATE TABLE rorca.spec_post_save_reconciliation_operations (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL CHECK(char_length(actor_id) BETWEEN 1 AND 160),
  authority_class TEXT NOT NULL CHECK(authority_class IN ('local_human_admin','internal_controller')),
  operation_kind TEXT NOT NULL CHECK(operation_kind='stage_reconciliation'),
  operation_key_hash TEXT NOT NULL CHECK(operation_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  response_json JSONB NOT NULL CHECK(jsonb_typeof(response_json)='object' AND octet_length(response_json::text)<=16384),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE(workspace_id,actor_id,authority_class,operation_kind,operation_key_hash)
);

ALTER TABLE rorca.spec_post_save_reconciliation_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.spec_post_save_reconciliation_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY spec_post_save_reconciliation_operations_runtime
  ON rorca.spec_post_save_reconciliation_operations
  USING (
    (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
      SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='migration_owner'
    )) OR
    (workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
      SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='internal_runtime'
    ))
  )
  WITH CHECK (
    (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
      SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='migration_owner'
    )) OR
    (workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
      SELECT 1 FROM rorca.wave2_database_principals p
      WHERE p.database_user=current_user AND p.principal_class='internal_runtime'
    ))
  );
CREATE TRIGGER spec_post_save_reconciliation_operations_immutable
  BEFORE UPDATE OR DELETE ON rorca.spec_post_save_reconciliation_operations
  FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER spec_post_save_reconciliation_operations_no_truncate
  BEFORE TRUNCATE ON rorca.spec_post_save_reconciliation_operations
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

ALTER TABLE rorca.spec_post_save_reconciliation_audit
  ADD COLUMN IF NOT EXISTS actor_id TEXT,
  ADD COLUMN IF NOT EXISTS authority_class TEXT,
  ADD COLUMN IF NOT EXISTS request_hash TEXT,
  ADD COLUMN IF NOT EXISTS operation_receipt_id BIGINT REFERENCES rorca.spec_post_save_reconciliation_operations(id) ON DELETE RESTRICT;
UPDATE rorca.spec_post_save_reconciliation_audit
SET actor_id=COALESCE(actor_id,'legacy:unattributed'),
    authority_class=COALESCE(authority_class,'internal_controller'),
    request_hash=COALESCE(request_hash,binding_hash)
WHERE actor_id IS NULL OR authority_class IS NULL OR request_hash IS NULL;
ALTER TABLE rorca.spec_post_save_reconciliation_audit
  ALTER COLUMN actor_id SET NOT NULL,
  ALTER COLUMN authority_class SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL;
ALTER TABLE rorca.spec_post_save_reconciliation_audit
  ADD CONSTRAINT spec_post_save_reconciliation_audit_actor_ck CHECK(char_length(actor_id) BETWEEN 1 AND 160),
  ADD CONSTRAINT spec_post_save_reconciliation_audit_authority_ck CHECK(authority_class IN ('local_human_admin','internal_controller')),
  ADD CONSTRAINT spec_post_save_reconciliation_audit_request_hash_ck CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$');
CREATE UNIQUE INDEX uq_spec_post_save_reconciliation_changed_replay
  ON rorca.spec_post_save_reconciliation_audit(operation_receipt_id)
  WHERE reason_code='idempotency_key_reused_with_changed_request';

-- Strict memory v2 binds the exact live material and derived-fact receipt.
ALTER TABLE rorca.spec_memory_synthesis_receipts
  ADD COLUMN IF NOT EXISTS workflow_run_id BIGINT REFERENCES rorca.spec_post_save_workflow_runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS workflow_stage_id BIGINT REFERENCES rorca.spec_post_save_workflow_stages(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS generation_log_id INTEGER REFERENCES rorca.spec_generation_logs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS material_hash TEXT,
  ADD COLUMN IF NOT EXISTS derivation_hash TEXT;
ALTER TABLE rorca.spec_memory_synthesis_receipts
  DROP CONSTRAINT IF EXISTS spec_memory_synthesis_receipts_sandbox_profile_check;
ALTER TABLE rorca.spec_memory_synthesis_receipts
  ADD CONSTRAINT spec_memory_synthesis_receipts_sandbox_profile_check
    CHECK(sandbox_profile IN ('linux-bwrap-strict-memory-v1','linux-bwrap-strict-memory-v2'));
ALTER TABLE rorca.spec_memory_synthesis_receipts
  ADD CONSTRAINT spec_memory_synthesis_receipts_material_hash_ck
    CHECK(material_hash IS NULL OR material_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT spec_memory_synthesis_receipts_derivation_hash_ck
    CHECK(derivation_hash IS NULL OR derivation_hash ~ '^sha256:[0-9a-f]{64}$');
CREATE UNIQUE INDEX uq_strict_memory_exact_stage_receipt
  ON rorca.spec_memory_synthesis_receipts(workflow_run_id,workflow_stage_id,application_job_id)
  WHERE workflow_run_id IS NOT NULL AND workflow_stage_id IS NOT NULL;

CREATE OR REPLACE FUNCTION rorca.validate_strict_memory_receipt_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stage_row rorca.spec_post_save_workflow_stages%ROWTYPE;
DECLARE run_row rorca.spec_post_save_workflow_runs%ROWTYPE;
DECLARE job_row rorca.spec_jobs%ROWTYPE;
DECLARE memory_row rorca.memories%ROWTYPE;
BEGIN
  IF NEW.sandbox_profile <> 'linux-bwrap-strict-memory-v2' THEN RETURN NEW; END IF;
  IF NEW.workflow_run_id IS NULL OR NEW.workflow_stage_id IS NULL OR NEW.generation_log_id IS NULL
     OR NEW.material_hash IS NULL OR NEW.derivation_hash IS NULL THEN
    RAISE EXCEPTION 'strict memory v2 exact receipt identity is incomplete' USING ERRCODE='23514';
  END IF;
  SELECT * INTO stage_row FROM rorca.spec_post_save_workflow_stages WHERE id=NEW.workflow_stage_id;
  SELECT * INTO run_row FROM rorca.spec_post_save_workflow_runs WHERE id=NEW.workflow_run_id;
  SELECT * INTO job_row FROM rorca.spec_jobs WHERE id=NEW.application_job_id;
  SELECT * INTO memory_row FROM rorca.memories WHERE id=NEW.memory_id;
  IF stage_row.run_id<>NEW.workflow_run_id OR stage_row.stage_key<>'memorySynthesis'
     OR stage_row.job_id<>NEW.application_job_id OR stage_row.boss_job_id::text<>job_row.boss_job_id::text
     OR stage_row.transport_schema IS DISTINCT FROM job_row.transport_schema
     OR run_row.workspace_id<>NEW.workspace_id OR run_row.spec_id<>NEW.spec_id
     OR run_row.generation_log_id<>NEW.generation_log_id OR run_row.save_generation<>NEW.save_generation
     OR run_row.effective_policy_hash<>NEW.policy_hash
     OR job_row.workspace_id<>NEW.workspace_id OR job_row.spec_id<>NEW.spec_id
     OR job_row.job_type<>'memory-synthesis' OR job_row.save_generation<>NEW.save_generation
     OR memory_row.workspace_id<>NEW.workspace_id OR memory_row.source_spec_id<>NEW.spec_id
     OR memory_row.source_type<>'auto-extracted' OR memory_row.source<>'strict-spec-derived-facts-v2' THEN
    RAISE EXCEPTION 'strict memory v2 receipt cross-table binding mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spec_memory_synthesis_receipts_validate_v2
BEFORE INSERT ON rorca.spec_memory_synthesis_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.validate_strict_memory_receipt_v2();

-- Exact invoker identity for the narrow SECURITY DEFINER capability. Runtime
-- has no privileges on this immutable authority anchor.
CREATE TABLE rorca.strict_memory_runtime_authority (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  database_user TEXT NOT NULL UNIQUE
);
INSERT INTO rorca.strict_memory_runtime_authority(database_user)
VALUES(current_setting('rorca.runtime_database_user',TRUE));
CREATE TRIGGER strict_memory_runtime_authority_immutable BEFORE UPDATE OR DELETE ON rorca.strict_memory_runtime_authority
FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER strict_memory_runtime_authority_no_truncate BEFORE TRUNCATE ON rorca.strict_memory_runtime_authority
FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();
REVOKE ALL ON rorca.strict_memory_runtime_authority FROM PUBLIC;
CREATE POLICY strict_memory_receipt_definer_read_v2 ON rorca.spec_memory_synthesis_receipts
FOR SELECT USING (
  workspace_id=current_setting('rorca.workspace_id',TRUE)
  AND EXISTS(SELECT 1 FROM rorca.strict_memory_runtime_authority authority WHERE authority.database_user=session_user)
);
CREATE POLICY strict_memory_receipt_definer_insert_v2 ON rorca.spec_memory_synthesis_receipts
FOR INSERT WITH CHECK (
  workspace_id=current_setting('rorca.workspace_id',TRUE)
  AND EXISTS(SELECT 1 FROM rorca.strict_memory_runtime_authority authority WHERE authority.database_user=session_user)
);

-- The only runtime memory insertion capability for this stage. Global lock
-- order is stage -> run -> generation log -> application job. The function
-- revalidates after sandbox execution and commits memory, immutable receipt,
-- and a payload-safe WAL event in one transaction.
CREATE OR REPLACE FUNCTION rorca.insert_strict_spec_derived_memory_v2(
  p_workspace_id TEXT,
  p_spec_id TEXT,
  p_workflow_run_id BIGINT,
  p_workflow_stage_id BIGINT,
  p_generation_log_id INTEGER,
  p_save_generation BIGINT,
  p_policy_hash TEXT,
  p_application_job_id UUID,
  p_material_hash TEXT,
  p_input_hash TEXT,
  p_output_hash TEXT,
  p_derivation_hash TEXT,
  p_category TEXT,
  p_content TEXT,
  p_confidence TEXT,
  p_related_files JSONB,
  p_provenance JSONB
) RETURNS TABLE(memory_id INTEGER,replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=rorca,pg_catalog AS $$
DECLARE stage_row rorca.spec_post_save_workflow_stages%ROWTYPE;
DECLARE run_row rorca.spec_post_save_workflow_runs%ROWTYPE;
DECLARE log_row rorca.spec_generation_logs%ROWTYPE;
DECLARE job_row rorca.spec_jobs%ROWTYPE;
DECLARE existing rorca.spec_memory_synthesis_receipts%ROWTYPE;
DECLARE new_memory_id INTEGER;
DECLARE computed_material_hash TEXT;
DECLARE derived_story_count INTEGER;
DECLARE derived_acceptance_count INTEGER;
DECLARE derived_dependency_count INTEGER;
DECLARE derived_root_count INTEGER;
DECLARE derived_missing_description_count INTEGER;
DECLARE derived_context_signal_count INTEGER;
DECLARE expected_content TEXT;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM rorca.strict_memory_runtime_authority authority WHERE authority.database_user=session_user)
     OR current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'strict memory runtime principal or workspace scope denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO stage_row FROM rorca.spec_post_save_workflow_stages WHERE id=p_workflow_stage_id FOR UPDATE;
  SELECT * INTO run_row FROM rorca.spec_post_save_workflow_runs WHERE id=p_workflow_run_id FOR UPDATE;
  SELECT * INTO log_row FROM rorca.spec_generation_logs WHERE id=p_generation_log_id FOR UPDATE;
  SELECT * INTO job_row FROM rorca.spec_jobs WHERE id=p_application_job_id FOR UPDATE;
  computed_material_hash := 'sha256:'||encode(rorca.digest(job_row.request_payload::text,'sha256'),'hex');
  SELECT count(*)::int,
         COALESCE(sum(CASE WHEN jsonb_typeof(story->'acceptanceCriteria')='array' THEN jsonb_array_length(story->'acceptanceCriteria') ELSE 0 END),0)::int,
         COALESCE(sum(CASE WHEN jsonb_typeof(story->'dependsOn')='array' THEN jsonb_array_length(story->'dependsOn') ELSE 0 END),0)::int,
         count(*) FILTER(WHERE CASE WHEN jsonb_typeof(story->'dependsOn')='array' THEN jsonb_array_length(story->'dependsOn') ELSE 0 END=0)::int,
         count(*) FILTER(WHERE btrim(COALESCE(story->>'description',''))='')::int
    INTO derived_story_count,derived_acceptance_count,derived_dependency_count,derived_root_count,derived_missing_description_count
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(job_row.request_payload#>'{memory,stories}')='array' THEN job_row.request_payload#>'{memory,stories}' ELSE '[]'::jsonb END) story;
  derived_context_signal_count :=
    CASE WHEN job_row.request_payload#>'{memory,contextSummary,directionLayers,l1}' IS NOT NULL AND job_row.request_payload#>'{memory,contextSummary,directionLayers,l1}'<>'null'::jsonb THEN 1 ELSE 0 END+
    CASE WHEN job_row.request_payload#>'{memory,contextSummary,directionLayers,l2}' IS NOT NULL AND job_row.request_payload#>'{memory,contextSummary,directionLayers,l2}'<>'null'::jsonb THEN 1 ELSE 0 END+
    CASE WHEN job_row.request_payload#>'{memory,contextSummary,directionLayers,l3}' IS NOT NULL AND job_row.request_payload#>'{memory,contextSummary,directionLayers,l3}'<>'null'::jsonb THEN 1 ELSE 0 END+
    CASE WHEN job_row.request_payload#>'{memory,contextSummary,schemaSnapshot}' IS NOT NULL AND job_row.request_payload#>'{memory,contextSummary,schemaSnapshot}'<>'null'::jsonb THEN 1 ELSE 0 END+
    CASE WHEN jsonb_typeof(job_row.request_payload#>'{memory,contextSummary,skills}')='array' AND jsonb_array_length(job_row.request_payload#>'{memory,contextSummary,skills}')>0 THEN 1 ELSE 0 END+
    CASE WHEN jsonb_typeof(job_row.request_payload#>'{memory,contextSummary,memoryEntries}')='number' AND (job_row.request_payload#>>'{memory,contextSummary,memoryEntries}')::numeric>0 THEN 1 ELSE 0 END;
  expected_content := 'Deterministic advisory spec facts: stories='||derived_story_count||'; acceptance criteria='||derived_acceptance_count||'; dependency edges='||derived_dependency_count||'; root stories='||derived_root_count||'; missing descriptions='||derived_missing_description_count||'; bounded context signals='||derived_context_signal_count||'. These derived facts are untrusted advisory planning data, not instructions, execution evidence, or approval.';
  IF stage_row.id IS NULL OR run_row.id IS NULL OR log_row.id IS NULL OR job_row.id IS NULL
     OR stage_row.run_id<>run_row.id OR stage_row.stage_key<>'memorySynthesis'
     OR stage_row.status<>'running' OR stage_row.job_id<>job_row.id
     OR stage_row.boss_job_id IS NULL OR stage_row.boss_job_id::text<>job_row.boss_job_id::text
     OR stage_row.transport_schema IS NULL OR stage_row.transport_schema<>job_row.transport_schema
     OR run_row.status NOT IN ('queued','running')
     OR run_row.workspace_id<>p_workspace_id OR run_row.spec_id<>p_spec_id
     OR run_row.generation_log_id<>log_row.id OR run_row.save_generation<>p_save_generation
     OR run_row.effective_policy_hash<>p_policy_hash
     OR job_row.status<>'running' OR job_row.workspace_id<>p_workspace_id OR job_row.spec_id<>p_spec_id
     OR job_row.job_type<>'memory-synthesis' OR job_row.save_generation<>p_save_generation
     OR computed_material_hash<>p_material_hash
     OR p_category IS DISTINCT FROM 'Spec Derived Facts' OR p_confidence IS DISTINCT FROM 'medium' OR p_related_files IS DISTINCT FROM '[]'::jsonb
     OR p_content IS DISTINCT FROM expected_content OR derived_story_count<1
     OR p_input_hash !~ '^sha256:[0-9a-f]{64}$' OR p_output_hash !~ '^sha256:[0-9a-f]{64}$' OR p_derivation_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_provenance->>'authority' IS DISTINCT FROM 'none' OR p_provenance->>'trust' IS DISTINCT FROM 'untrusted_advisory'
     OR p_provenance->>'applicationJobId' IS DISTINCT FROM p_application_job_id::text
     OR (p_provenance->>'workflowRunId')::bigint IS DISTINCT FROM p_workflow_run_id
     OR (p_provenance->>'workflowStageId')::bigint IS DISTINCT FROM p_workflow_stage_id
     OR (p_provenance->>'generationLogId')::integer IS DISTINCT FROM p_generation_log_id
     OR p_provenance->>'materialHash' IS DISTINCT FROM p_material_hash OR p_provenance->>'derivationHash' IS DISTINCT FROM p_derivation_hash
     OR jsonb_typeof(p_provenance->'derivationReferences') IS DISTINCT FROM 'array' OR jsonb_array_length(p_provenance->'derivationReferences')<>6
     OR NOT EXISTS(
       SELECT 1 FROM rorca.spec_generation_logs latest
       WHERE latest.id=log_row.id AND latest.spec_slug=p_spec_id
         AND COALESCE(latest.save_generation,latest.id::bigint)=p_save_generation
         AND NOT EXISTS(
           SELECT 1 FROM rorca.spec_generation_logs newer
           WHERE newer.spec_slug=p_spec_id
             AND COALESCE(newer.save_generation,newer.id::bigint)>p_save_generation
         )
     ) THEN
    RAISE EXCEPTION 'strict memory exact live material revalidation failed' USING ERRCODE='40001';
  END IF;

  SELECT * INTO existing FROM rorca.spec_memory_synthesis_receipts
   WHERE workspace_id=p_workspace_id AND spec_id=p_spec_id
     AND save_generation=p_save_generation AND policy_hash=p_policy_hash;
  IF existing.workspace_id IS NOT NULL THEN
    IF existing.workflow_run_id<>p_workflow_run_id OR existing.workflow_stage_id<>p_workflow_stage_id
       OR existing.generation_log_id<>p_generation_log_id OR existing.application_job_id<>p_application_job_id
       OR existing.material_hash<>p_material_hash OR existing.input_hash<>p_input_hash
       OR existing.output_hash<>p_output_hash OR existing.derivation_hash<>p_derivation_hash
       OR existing.sandbox_profile<>'linux-bwrap-strict-memory-v2' THEN
      RAISE EXCEPTION 'strict memory replay binding mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.memory_id,TRUE;
    RETURN;
  END IF;

  INSERT INTO rorca.memories(workspace_id,category,content,source_spec_id,confidence,related_files,source_type,source,provenance)
  VALUES(p_workspace_id,p_category,p_content,p_spec_id,p_confidence,p_related_files,'auto-extracted','strict-spec-derived-facts-v2',p_provenance)
  RETURNING id INTO new_memory_id;
  INSERT INTO rorca.spec_memory_synthesis_receipts(
    workspace_id,spec_id,save_generation,policy_hash,application_job_id,memory_id,input_hash,output_hash,sandbox_profile,
    workflow_run_id,workflow_stage_id,generation_log_id,material_hash,derivation_hash
  ) VALUES(
    p_workspace_id,p_spec_id,p_save_generation,p_policy_hash,p_application_job_id,new_memory_id,p_input_hash,p_output_hash,
    'linux-bwrap-strict-memory-v2',p_workflow_run_id,p_workflow_stage_id,p_generation_log_id,p_material_hash,p_derivation_hash
  );
  INSERT INTO rorca.wal_events(event_type,spec_id,workspace_id,payload)
  VALUES('memory_created',p_spec_id,p_workspace_id,jsonb_build_object(
    'schemaVersion','rorca.strict-spec-memory-event.v1','memoryId',new_memory_id,'workflowRunId',p_workflow_run_id,
    'workflowStageId',p_workflow_stage_id,'generationLogId',p_generation_log_id,'saveGeneration',p_save_generation,
    'materialHash',p_material_hash,'derivationHash',p_derivation_hash,'authority','none','trust','untrusted_advisory'
  ));
  RETURN QUERY SELECT new_memory_id,FALSE;
END $$;
REVOKE ALL ON FUNCTION rorca.insert_strict_spec_derived_memory_v2(TEXT,TEXT,BIGINT,BIGINT,INTEGER,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB) FROM PUBLIC;

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal'; END IF;
  EXECUTE format('GRANT SELECT,INSERT ON rorca.spec_post_save_reconciliation_operations TO %I',runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.spec_post_save_reconciliation_operations_id_seq TO %I',runtime_user);
  EXECUTE format('REVOKE INSERT ON rorca.memories FROM %I',runtime_user);
  EXECUTE format('REVOKE USAGE ON SEQUENCE rorca.memories_id_seq FROM %I',runtime_user);
  EXECUTE format('REVOKE INSERT ON rorca.spec_memory_synthesis_receipts FROM %I',runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.insert_strict_spec_derived_memory_v2(TEXT,TEXT,BIGINT,BIGINT,INTEGER,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB) TO %I',runtime_user);
  -- Replace the table-wide UPDATE grants from 148 with the columns required by
  -- the reviewed worker CAS. Publication gets explicit insert columns only.
  EXECUTE format('REVOKE UPDATE ON rorca.spec_jobs,rorca.spec_post_save_workflow_runs,rorca.spec_post_save_workflow_stages FROM %I',runtime_user);
  EXECUTE format('GRANT SELECT ON rorca.spec_generation_logs,rorca.spec_jobs,rorca.spec_post_save_workflow_runs,rorca.spec_post_save_workflow_stages,rorca.spec_post_save_stage_dependencies TO %I',runtime_user);
  EXECUTE format('GRANT INSERT(workspace_id,spec_id,generation_log_id,save_generation,effective_policy_hash,effective_policy,idempotency_key,status,source) ON rorca.spec_post_save_workflow_runs TO %I',runtime_user);
  EXECUTE format('GRANT UPDATE(status,updated_at,finished_at,error_message) ON rorca.spec_post_save_workflow_runs TO %I',runtime_user);
  EXECUTE format('GRANT INSERT(run_id,stage_key,requested,status,reason,job_id,boss_job_id,queue_name,transport_schema,queue_status,queue_position,active_jobs_ahead,queue_priority,singleton_key,fingerprint,previous_fingerprint,error_message,details,started_at,finished_at) ON rorca.spec_post_save_workflow_stages TO %I',runtime_user);
  EXECUTE format('GRANT UPDATE(status,reason,job_id,boss_job_id,queue_name,transport_schema,queue_status,queue_position,active_jobs_ahead,queue_priority,singleton_key,fingerprint,previous_fingerprint,error_message,details,updated_at,started_at,finished_at) ON rorca.spec_post_save_workflow_stages TO %I',runtime_user);
  EXECUTE format('GRANT INSERT(run_id,stage_key,depends_on_stage_key) ON rorca.spec_post_save_stage_dependencies TO %I',runtime_user);
  EXECUTE format('GRANT INSERT(workspace_id,spec_id,job_type,status,request_payload,save_generation,transport_schema) ON rorca.spec_jobs TO %I',runtime_user);
  EXECUTE format('GRANT UPDATE(status,boss_job_id,transport_schema,progress_current,progress_total,progress_message,request_payload,result_payload,error_message,started_at,finished_at) ON rorca.spec_jobs TO %I',runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.spec_post_save_workflow_runs_id_seq,rorca.spec_post_save_workflow_stages_id_seq TO %I',runtime_user);
END $$;

UPDATE rorca.wave2_schema_readiness SET migration_version=20260729150000,installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729149000
 AND contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260729150000) THEN
  RAISE EXCEPTION 'Wave 2 reconciler remediation readiness transition failed closed' USING ERRCODE='55000';
 END IF;
END $$;
