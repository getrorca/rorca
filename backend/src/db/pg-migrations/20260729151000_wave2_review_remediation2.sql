-- Wave 2 second independent-review remediation. Preserve the rejected 148-150
-- upgrade path while fixing fresh native PostgreSQL, split-principal runtime,
-- pgcrypto namespace, strict-memory freshness/provenance, and rejected audit.

-- pgcrypto may be preinstalled in public (managed/native) or rorca. Pin one
-- controlled wrapper in the application schema instead of assuming extnamespace.
DO $$
DECLARE crypto_schema TEXT;
BEGIN
  SELECT n.nspname INTO crypto_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
   WHERE e.extname='pgcrypto';
  IF crypto_schema IS NULL THEN
    RAISE EXCEPTION 'pgcrypto extension is required for Wave 2' USING ERRCODE='55000';
  END IF;
  IF crypto_schema <> 'rorca' THEN
    EXECUTE format($fn$
      CREATE OR REPLACE FUNCTION rorca.digest(TEXT,TEXT) RETURNS BYTEA
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
      AS 'SELECT %I.digest($1,$2)'
    $fn$,crypto_schema);
  END IF;
END $$;
REVOKE ALL ON FUNCTION rorca.digest(TEXT,TEXT) FROM PUBLIC;

-- Ordinary application memory creation remains available to the runtime role,
-- but direct fabrication of the reserved strict-derived source is rejected.
CREATE OR REPLACE FUNCTION rorca.reject_direct_strict_memory_source()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source='strict-spec-derived-facts-v2' AND current_user=session_user THEN
    RAISE EXCEPTION 'strict derived memory requires the reviewed definer capability' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS memories_strict_source_capability ON rorca.memories;
CREATE TRIGGER memories_strict_source_capability
BEFORE INSERT OR UPDATE OF source ON rorca.memories
FOR EACH ROW EXECUTE FUNCTION rorca.reject_direct_strict_memory_source();

-- The runtime principal is the application principal, not a migration owner.
-- Grant legacy application DML explicitly by excluding every Wave 2 governed
-- relation, whose prior narrow grants/RLS remain authoritative. No CREATE,
-- schema ownership, migration ledger, role, or provider authority is granted.
DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
DECLARE transport_schema TEXT := current_setting('rorca.pgboss_schema',TRUE);
DECLARE transport_owner TEXT;
DECLARE relation_name TEXT;
DECLARE protected CONSTANT TEXT[] := ARRAY[
  'context_bundle_deltas','context_bundles','context_checkpoints','context_contract_release_history',
  'context_epoch_client_migrations','context_epoch_projection_reads','context_epoch_retirement_evaluations',
  'context_epoch_retirement_evidence','context_epoch_retirement_review_decisions','context_epoch_write_rejections',
  'context_policy_activation_heads','context_policy_activations','context_policy_authority_receipts','context_policy_definitions',
  'context_retrieval_receipts','context_retrieval_sources','context_scope_heads','continuation_dispatch_consumptions',
  'continuation_dispatch_outbox','continuation_dispatch_outcomes','continuation_dispatches','continuation_quarantines',
  'continuation_retry_budgets','continuation_retry_events','execution_cancellation_acknowledgements',
  'execution_cancellation_requests','execution_lease_events','execution_lease_slots','execution_leases',
  'governed_closeout_evaluations','governed_decision_authority_snapshots','governed_evidence_obligations',
  'governed_execution_attempts','governed_mission_heads','governed_mission_versions','governed_missions',
  'governed_spec_authority_snapshots','governed_work_package_dependencies','governed_work_package_heads',
  'governed_work_package_revisions','governed_work_packages','managed_executor_compatibility_events',
  'mission_control_audit','mission_control_idempotency','mission_control_replay_conflicts','plan_change_proposal_heads',
  'plan_change_proposal_reviews','plan_change_proposals','runtime_event_conflicts','runtime_event_stream_heads','runtime_events',
  'spec_memory_synthesis_receipts','spec_post_save_reconciliation_audit','spec_post_save_reconciliation_operations',
  'strict_memory_runtime_authority','wave2_database_principals','wave2_prerequisite_receipts','wave2_schema_readiness'
];
BEGIN
  IF runtime_user IS NULL OR runtime_user='' OR NOT EXISTS(
    SELECT 1 FROM pg_roles WHERE rolname=runtime_user AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls
  ) THEN RAISE EXCEPTION 'registered Wave 2 runtime principal is required' USING ERRCODE='42501'; END IF;
  -- pg-boss remains the sole manager of its validated configurable transport
  -- schema. Never grant database-wide CREATE to the runtime principal.
  IF transport_schema IS NULL OR transport_schema !~ '^pgboss(?:_[a-z0-9_]{1,48})?$' THEN
    RAISE EXCEPTION 'validated pg-boss schema setting is required' USING ERRCODE='22023';
  END IF;
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I',current_database(),runtime_user);
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I',transport_schema);
  SELECT pg_get_userbyid(nspowner) INTO transport_owner FROM pg_namespace WHERE nspname=transport_schema;
  IF transport_owner=current_user THEN
    EXECUTE format('GRANT USAGE,CREATE ON SCHEMA %I TO %I',transport_schema,runtime_user);
    EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I TO %I',transport_schema,runtime_user);
    EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I TO %I',transport_schema,runtime_user);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I',transport_schema,runtime_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ALL PRIVILEGES ON TABLES TO %I',current_user,transport_schema,runtime_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ALL PRIVILEGES ON SEQUENCES TO %I',current_user,transport_schema,runtime_user);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I',current_user,transport_schema,runtime_user);
  ELSIF transport_owner<>runtime_user THEN
    RAISE EXCEPTION 'pg-boss schema has an untrusted owner' USING ERRCODE='42501';
  END IF;
  FOR relation_name IN
    SELECT tablename FROM pg_tables WHERE schemaname='rorca' AND NOT(tablename=ANY(protected))
  LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON rorca.%I TO %I',relation_name,runtime_user);
  END LOOP;
  FOR relation_name IN SELECT sequencename FROM pg_sequences WHERE schemaname='rorca'
  LOOP
    EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.%I TO %I',relation_name,runtime_user);
  END LOOP;
  -- Restore ordinary memory APIs while retaining receipt isolation and the
  -- reserved-source trigger above.
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON rorca.memories TO %I',runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.memories_id_seq TO %I',runtime_user);
  EXECUTE format('REVOKE INSERT,UPDATE,DELETE ON rorca.spec_memory_synthesis_receipts FROM %I',runtime_user);
  EXECUTE format('REVOKE ALL ON rorca.strict_memory_runtime_authority FROM %I',runtime_user);
END $$;

-- Legacy RLS remains request-claim scoped after SET ROLE authenticated. The
-- registered internal runtime needs its distinct system/worker path; this does
-- not apply to the authenticated role and grants no schema or migration power.
DO $$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['workspaces','direction_layers','wal_events','team_invites','api_key_vault'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS wave2_internal_runtime_legacy ON rorca.%I',relation_name);
    EXECUTE format($policy$CREATE POLICY wave2_internal_runtime_legacy ON rorca.%I
      USING(EXISTS(SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='internal_runtime'))
      WITH CHECK(EXISTS(SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='internal_runtime'))$policy$,relation_name);
  END LOOP;
END $$;

-- Rebuild strict persistence with one workspace/spec advisory transaction fence,
-- identical structural bounds, and independently-derived exact references.
CREATE OR REPLACE FUNCTION rorca.insert_strict_spec_derived_memory_v2(
  p_workspace_id TEXT,p_spec_id TEXT,p_workflow_run_id BIGINT,p_workflow_stage_id BIGINT,
  p_generation_log_id INTEGER,p_save_generation BIGINT,p_policy_hash TEXT,p_application_job_id UUID,
  p_material_hash TEXT,p_input_hash TEXT,p_output_hash TEXT,p_derivation_hash TEXT,p_category TEXT,
  p_content TEXT,p_confidence TEXT,p_related_files JSONB,p_provenance JSONB
) RETURNS TABLE(memory_id INTEGER,replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rorca,pg_catalog AS $$
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
DECLARE acceptance_paths JSONB;
DECLARE dependency_paths JSONB;
DECLARE description_paths JSONB;
DECLARE derived_references JSONB;
DECLARE exact_provenance JSONB;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM rorca.strict_memory_runtime_authority authority WHERE authority.database_user=session_user)
     OR current_setting('rorca.workspace_id',TRUE) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'strict memory runtime principal or workspace scope denied' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('spec-generation-head:'||p_workspace_id||':'||p_spec_id,0));
  SELECT * INTO stage_row FROM rorca.spec_post_save_workflow_stages WHERE id=p_workflow_stage_id FOR UPDATE;
  SELECT * INTO run_row FROM rorca.spec_post_save_workflow_runs WHERE id=p_workflow_run_id FOR UPDATE;
  SELECT * INTO log_row FROM rorca.spec_generation_logs WHERE id=p_generation_log_id FOR UPDATE;
  SELECT * INTO job_row FROM rorca.spec_jobs WHERE id=p_application_job_id FOR UPDATE;
  computed_material_hash := 'sha256:'||encode(rorca.digest(job_row.request_payload::text,'sha256'),'hex');

  IF jsonb_typeof(job_row.request_payload#>'{memory,stories}')<>'array'
     OR jsonb_array_length(job_row.request_payload#>'{memory,stories}') NOT BETWEEN 1 AND 64
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(job_row.request_payload#>'{memory,stories}') story
       WHERE jsonb_typeof(story)<>'object'
          OR (jsonb_typeof(story->'acceptanceCriteria')='array' AND jsonb_array_length(story->'acceptanceCriteria')>20)
          OR (jsonb_typeof(story->'dependsOn')='array' AND jsonb_array_length(story->'dependsOn')>64)) THEN
    RAISE EXCEPTION 'strict memory structural bounds exceeded' USING ERRCODE='22023';
  END IF;

  SELECT count(*)::int,
         COALESCE(sum(CASE WHEN jsonb_typeof(story->'acceptanceCriteria')='array' THEN jsonb_array_length(story->'acceptanceCriteria') ELSE 0 END),0)::int,
         COALESCE(sum(CASE WHEN jsonb_typeof(story->'dependsOn')='array' THEN jsonb_array_length(story->'dependsOn') ELSE 0 END),0)::int,
         count(*) FILTER(WHERE CASE WHEN jsonb_typeof(story->'dependsOn')='array' THEN jsonb_array_length(story->'dependsOn') ELSE 0 END=0)::int,
         count(*) FILTER(WHERE btrim(COALESCE(story->>'description',''))='')::int,
         COALESCE(jsonb_agg(to_jsonb(format('stories[%s].acceptanceCriteria',ordinal-1)) ORDER BY ordinal),'[]'::jsonb),
         COALESCE(jsonb_agg(to_jsonb(format('stories[%s].dependsOn',ordinal-1)) ORDER BY ordinal),'[]'::jsonb),
         COALESCE(jsonb_agg(to_jsonb(format('stories[%s].description',ordinal-1)) ORDER BY ordinal),'[]'::jsonb)
    INTO derived_story_count,derived_acceptance_count,derived_dependency_count,derived_root_count,
         derived_missing_description_count,acceptance_paths,dependency_paths,description_paths
    FROM jsonb_array_elements(job_row.request_payload#>'{memory,stories}') WITH ORDINALITY item(story,ordinal);
  derived_context_signal_count :=
    CASE WHEN job_row.request_payload#>'{memory,contextSummary,directionLayers,l1}' IS NOT NULL AND job_row.request_payload#>'{memory,contextSummary,directionLayers,l1}'<>'null'::jsonb THEN 1 ELSE 0 END+
    CASE WHEN job_row.request_payload#>'{memory,contextSummary,directionLayers,l2}' IS NOT NULL AND job_row.request_payload#>'{memory,contextSummary,directionLayers,l2}'<>'null'::jsonb THEN 1 ELSE 0 END+
    CASE WHEN job_row.request_payload#>'{memory,contextSummary,directionLayers,l3}' IS NOT NULL AND job_row.request_payload#>'{memory,contextSummary,directionLayers,l3}'<>'null'::jsonb THEN 1 ELSE 0 END+
    CASE WHEN job_row.request_payload#>'{memory,contextSummary,schemaSnapshot}' IS NOT NULL AND job_row.request_payload#>'{memory,contextSummary,schemaSnapshot}'<>'null'::jsonb THEN 1 ELSE 0 END+
    CASE WHEN jsonb_typeof(job_row.request_payload#>'{memory,contextSummary,skills}')='array' AND jsonb_array_length(job_row.request_payload#>'{memory,contextSummary,skills}')>0 THEN 1 ELSE 0 END+
    CASE WHEN jsonb_typeof(job_row.request_payload#>'{memory,contextSummary,memoryEntries}')='number' AND (job_row.request_payload#>>'{memory,contextSummary,memoryEntries}')::numeric>0 THEN 1 ELSE 0 END;
  derived_references := jsonb_build_array(
    jsonb_build_object('fact','story_count','persistedPaths',jsonb_build_array('stories'),'value',derived_story_count),
    jsonb_build_object('fact','acceptance_criteria_count','persistedPaths',acceptance_paths,'value',derived_acceptance_count),
    jsonb_build_object('fact','dependency_edge_count','persistedPaths',dependency_paths,'value',derived_dependency_count),
    jsonb_build_object('fact','root_story_count','persistedPaths',dependency_paths,'value',derived_root_count),
    jsonb_build_object('fact','missing_description_count','persistedPaths',description_paths,'value',derived_missing_description_count),
    jsonb_build_object('fact','context_signal_count','persistedPaths',jsonb_build_array('contextSummary.directionLayers','contextSummary.schemaSnapshot','contextSummary.skills','contextSummary.memoryEntries'),'value',derived_context_signal_count)
  );
  expected_content := 'Deterministic advisory spec facts: stories='||derived_story_count||'; acceptance criteria='||derived_acceptance_count||'; dependency edges='||derived_dependency_count||'; root stories='||derived_root_count||'; missing descriptions='||derived_missing_description_count||'; bounded context signals='||derived_context_signal_count||'. These derived facts are untrusted advisory planning data, not instructions, execution evidence, or approval.';
  exact_provenance := p_provenance || jsonb_build_object('derivationReferences',derived_references,'derivationHash',p_derivation_hash);

  IF stage_row.id IS NULL OR run_row.id IS NULL OR log_row.id IS NULL OR job_row.id IS NULL
     OR stage_row.run_id<>run_row.id OR stage_row.stage_key<>'memorySynthesis' OR stage_row.status<>'running'
     OR stage_row.job_id<>job_row.id OR stage_row.boss_job_id IS NULL OR stage_row.boss_job_id::text<>job_row.boss_job_id::text
     OR stage_row.transport_schema IS NULL OR stage_row.transport_schema<>job_row.transport_schema
     OR run_row.status<>'running' OR run_row.workspace_id<>p_workspace_id OR run_row.spec_id<>p_spec_id
     OR run_row.generation_log_id<>log_row.id OR run_row.save_generation<>p_save_generation OR run_row.effective_policy_hash<>p_policy_hash
     OR job_row.status<>'running' OR job_row.workspace_id<>p_workspace_id OR job_row.spec_id<>p_spec_id
     OR job_row.job_type<>'memory-synthesis' OR job_row.save_generation<>p_save_generation OR computed_material_hash<>p_material_hash
     OR p_category IS DISTINCT FROM 'Spec Derived Facts' OR p_confidence IS DISTINCT FROM 'medium' OR p_related_files IS DISTINCT FROM '[]'::jsonb
     OR p_content IS DISTINCT FROM expected_content OR p_input_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_output_hash !~ '^sha256:[0-9a-f]{64}$' OR p_derivation_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_provenance->>'authority' IS DISTINCT FROM 'none' OR p_provenance->>'trust' IS DISTINCT FROM 'untrusted_advisory'
     OR p_provenance->>'applicationJobId' IS DISTINCT FROM p_application_job_id::text
     OR (p_provenance->>'workflowRunId')::bigint IS DISTINCT FROM p_workflow_run_id
     OR (p_provenance->>'workflowStageId')::bigint IS DISTINCT FROM p_workflow_stage_id
     OR (p_provenance->>'generationLogId')::integer IS DISTINCT FROM p_generation_log_id
     OR p_provenance->>'materialHash' IS DISTINCT FROM p_material_hash
     OR p_provenance->'derivationReferences' IS DISTINCT FROM derived_references
     OR NOT EXISTS(SELECT 1 FROM rorca.spec_generation_logs latest
       WHERE latest.id=log_row.id AND latest.spec_slug=p_spec_id
         AND latest.context_summary_json->>'workspaceId'=p_workspace_id
         AND COALESCE(latest.save_generation,latest.id::bigint)=p_save_generation
         AND NOT EXISTS(SELECT 1 FROM rorca.spec_generation_logs newer
           WHERE newer.spec_slug=p_spec_id AND newer.context_summary_json->>'workspaceId'=p_workspace_id
             AND COALESCE(newer.save_generation,newer.id::bigint)>p_save_generation)) THEN
    RAISE EXCEPTION 'strict memory exact live material revalidation failed' USING ERRCODE='40001';
  END IF;

  SELECT * INTO existing FROM rorca.spec_memory_synthesis_receipts
   WHERE workspace_id=p_workspace_id AND spec_id=p_spec_id AND save_generation=p_save_generation AND policy_hash=p_policy_hash;
  IF existing.workspace_id IS NOT NULL THEN
    IF existing.workflow_run_id<>p_workflow_run_id OR existing.workflow_stage_id<>p_workflow_stage_id
       OR existing.generation_log_id<>p_generation_log_id OR existing.application_job_id<>p_application_job_id
       OR existing.material_hash<>p_material_hash OR existing.input_hash<>p_input_hash OR existing.output_hash<>p_output_hash
       OR existing.derivation_hash<>p_derivation_hash OR existing.sandbox_profile<>'linux-bwrap-strict-memory-v2' THEN
      RAISE EXCEPTION 'strict memory replay binding mismatch' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.memory_id,TRUE; RETURN;
  END IF;

  INSERT INTO rorca.memories(workspace_id,category,content,source_spec_id,confidence,related_files,source_type,source,provenance)
  VALUES(p_workspace_id,p_category,p_content,p_spec_id,p_confidence,p_related_files,'auto-extracted','strict-spec-derived-facts-v2',exact_provenance)
  RETURNING id INTO new_memory_id;
  INSERT INTO rorca.spec_memory_synthesis_receipts(
    workspace_id,spec_id,save_generation,policy_hash,application_job_id,memory_id,input_hash,output_hash,sandbox_profile,
    workflow_run_id,workflow_stage_id,generation_log_id,material_hash,derivation_hash)
  VALUES(p_workspace_id,p_spec_id,p_save_generation,p_policy_hash,p_application_job_id,new_memory_id,p_input_hash,p_output_hash,
    'linux-bwrap-strict-memory-v2',p_workflow_run_id,p_workflow_stage_id,p_generation_log_id,p_material_hash,p_derivation_hash);
  INSERT INTO rorca.wal_events(event_type,spec_id,workspace_id,payload)
  VALUES('memory_created',p_spec_id,p_workspace_id,jsonb_build_object(
    'schemaVersion','rorca.strict-spec-memory-event.v1','memoryId',new_memory_id,'workflowRunId',p_workflow_run_id,
    'workflowStageId',p_workflow_stage_id,'generationLogId',p_generation_log_id,'saveGeneration',p_save_generation,
    'materialHash',p_material_hash,'derivationHash',p_derivation_hash,'authority','none','trust','untrusted_advisory'));
  RETURN QUERY SELECT new_memory_id,FALSE;
END $$;
REVOKE ALL ON FUNCTION rorca.insert_strict_spec_derived_memory_v2(TEXT,TEXT,BIGINT,BIGINT,INTEGER,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB) FROM PUBLIC;
DO $$ DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE); BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.insert_strict_spec_derived_memory_v2(TEXT,TEXT,BIGINT,BIGINT,INTEGER,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB) TO %I',runtime_user);
END $$;

-- Exact apply receipts for MCP/auth repair mutations. A claimed operation is
-- never executed twice after an ambiguous process failure; completed replay
-- returns the bounded original response and changed replay fails closed.
CREATE TABLE rorca.spec_repair_operations(
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL CHECK(char_length(actor_id) BETWEEN 1 AND 160),
  surface TEXT NOT NULL CHECK(surface IN('repair','repair_batch','stage_retry')),
  operation_key_hash TEXT NOT NULL CHECK(operation_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK(status IN('in_progress','completed')),
  response_json JSONB CHECK(response_json IS NULL OR (jsonb_typeof(response_json)='object' AND octet_length(response_json::text)<=1048576)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  completed_at TIMESTAMPTZ,
  UNIQUE(workspace_id,actor_id,surface,operation_key_hash),
  CHECK((status='in_progress' AND response_json IS NULL AND completed_at IS NULL) OR
        (status='completed' AND response_json IS NOT NULL AND completed_at IS NOT NULL))
);
ALTER TABLE rorca.spec_repair_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.spec_repair_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY spec_repair_operations_runtime ON rorca.spec_repair_operations USING(
  workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS(
    SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='internal_runtime'))
WITH CHECK(workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS(
    SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='internal_runtime'));
CREATE OR REPLACE FUNCTION rorca.guard_spec_repair_operation_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR OLD.status='completed' OR NEW.workspace_id<>OLD.workspace_id OR NEW.actor_id<>OLD.actor_id OR NEW.surface<>OLD.surface
     OR NEW.operation_key_hash<>OLD.operation_key_hash OR NEW.request_hash<>OLD.request_hash OR NEW.created_at<>OLD.created_at
     OR NEW.status<>'completed' THEN RAISE EXCEPTION 'spec repair operation is immutable or transition-invalid' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spec_repair_operations_guard BEFORE UPDATE OR DELETE ON rorca.spec_repair_operations
FOR EACH ROW EXECUTE FUNCTION rorca.guard_spec_repair_operation_update();
CREATE TRIGGER spec_repair_operations_no_truncate BEFORE TRUNCATE ON rorca.spec_repair_operations
FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();
DO $$ DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE); BEGIN
  EXECUTE format('GRANT SELECT,INSERT ON rorca.spec_repair_operations TO %I',runtime_user);
  EXECUTE format('GRANT UPDATE(status,response_json,completed_at) ON rorca.spec_repair_operations TO %I',runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.spec_repair_operations_id_seq TO %I',runtime_user);
END $$;

UPDATE rorca.wave2_schema_readiness SET migration_version=20260729151000,installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729150000
 AND contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260729151000) THEN
  RAISE EXCEPTION 'Wave 2 review remediation 2 readiness transition failed closed' USING ERRCODE='55000';
 END IF;
END $$;
