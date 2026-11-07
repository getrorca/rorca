-- Wave 6 fix: darwin memory synthesis execution envelope.
-- The strict memory sandbox now runs the identical static child on Darwin
-- (hermetic node, no shell/env, bounded output, timeout) with an honest
-- profile name. The receipts CHECK, exact-receipt trigger, and the
-- SECURITY DEFINER insert function accept the darwin profile and carry it
-- through provenance instead of hardcoding the linux literal. All original
-- v2 exact-binding predicates are preserved verbatim.

ALTER TABLE rorca.spec_memory_synthesis_receipts
  DROP CONSTRAINT IF EXISTS spec_memory_synthesis_receipts_sandbox_profile_check;
ALTER TABLE rorca.spec_memory_synthesis_receipts
  ADD CONSTRAINT spec_memory_synthesis_receipts_sandbox_profile_check
    CHECK(sandbox_profile IN ('linux-bwrap-strict-memory-v1','linux-bwrap-strict-memory-v2','darwin-hermetic-node-v2'));

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
  p_provenance JSONB,
  p_sandbox_profile TEXT
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
  IF p_sandbox_profile NOT IN ('linux-bwrap-strict-memory-v1','linux-bwrap-strict-memory-v2','darwin-hermetic-node-v2') THEN
    RAISE EXCEPTION 'strict memory sandbox profile is not recognized' USING ERRCODE='23514';
  END IF;
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
       OR existing.sandbox_profile<>p_sandbox_profile THEN
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
    p_sandbox_profile,p_workflow_run_id,p_workflow_stage_id,p_generation_log_id,p_material_hash,p_derivation_hash
  );
  INSERT INTO rorca.wal_events(event_type,spec_id,workspace_id,payload)
  VALUES('memory_created',p_spec_id,p_workspace_id,jsonb_build_object(
    'schemaVersion','rorca.strict-spec-memory-event.v1','memoryId',new_memory_id,'workflowRunId',p_workflow_run_id,
    'workflowStageId',p_workflow_stage_id,'generationLogId',p_generation_log_id,'saveGeneration',p_save_generation,
    'materialHash',p_material_hash,'derivationHash',p_derivation_hash,'authority','none','trust','untrusted_advisory'
  ));
  RETURN QUERY SELECT new_memory_id,FALSE;
END $$;

CREATE OR REPLACE FUNCTION rorca.validate_strict_memory_receipt_v2()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stage_row rorca.spec_post_save_workflow_stages%ROWTYPE;
DECLARE run_row rorca.spec_post_save_workflow_runs%ROWTYPE;
DECLARE job_row rorca.spec_jobs%ROWTYPE;
DECLARE memory_row rorca.memories%ROWTYPE;
BEGIN
  IF NEW.sandbox_profile NOT IN ('linux-bwrap-strict-memory-v2','darwin-hermetic-node-v2') THEN RETURN NEW; END IF;
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
