-- Wave 4 bounded federated runtime pilot. One identity, one active execution, exact canonical bindings.
CREATE TABLE rorca.wave4_federation_readiness (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  reviewed_wave2_sha TEXT NOT NULL CHECK(reviewed_wave2_sha ~ '^[0-9a-f]{40}$'),
  reviewed_wave3_sha TEXT NOT NULL CHECK(reviewed_wave3_sha ~ '^[0-9a-f]{40}$'),
  wave3a_spec_revision TEXT NOT NULL CHECK(wave3a_spec_revision ~ '^sha256:[0-9a-f]{64}$'),
  wave3b_spec_revision TEXT NOT NULL CHECK(wave3b_spec_revision ~ '^sha256:[0-9a-f]{64}$'),
  wave2_migration_head BIGINT NOT NULL, wave3a_migration_head BIGINT NOT NULL, wave3b_migration_head BIGINT NOT NULL,
  wave2_prerequisite_receipt_hash TEXT NOT NULL REFERENCES rorca.wave2_prerequisite_receipts(receipt_hash) ON DELETE RESTRICT,
  contract_version TEXT NOT NULL,
  conformance_receipt_hash TEXT NOT NULL CHECK(conformance_receipt_hash='sha256:c998212b90ef90d3c6aabd3f26c2a2ecf15a7df4fecea44c5a663b4bf159a5c4'),
  independent_review_receipt_hash TEXT NOT NULL CHECK(independent_review_receipt_hash='sha256:4e9ef68f52918a33471b04dab4a084a177d0b5b5289aae12c622d7977459edeb'),
  wave3_security_review_receipt_hash TEXT NOT NULL CHECK(wave3_security_review_receipt_hash='sha256:dc093ac2fbed1642b6203541828503d90539d8cb7aea4b15f37409e58edaf8d0'),
  wave3_release_review_receipt_hash TEXT NOT NULL CHECK(wave3_release_review_receipt_hash='sha256:51cca9d2ed931e2f482f180f57ae50197a7b0ba20a9c72c330ab5300311d295f'),
  wave3_security_reviewer_id TEXT NOT NULL CHECK(wave3_security_reviewer_id='Wave3SecFinal2'),
  wave3_release_reviewer_id TEXT NOT NULL CHECK(wave3_release_reviewer_id='Wave3RelFinal2'),
  wave3_security_verdict TEXT NOT NULL CHECK(wave3_security_verdict='accepted'),
  wave3_release_verdict TEXT NOT NULL CHECK(wave3_release_verdict='accepted'),
  wave3_security_finding_count INTEGER NOT NULL CHECK(wave3_security_finding_count=0),
  wave3_release_finding_count INTEGER NOT NULL CHECK(wave3_release_finding_count=0),
  reviewed_wave3_tree_sha TEXT NOT NULL CHECK(reviewed_wave3_tree_sha='a8bea27e85c9340d69ed078cd15a9dbfdc586abd'),
  compatibility_hash TEXT NOT NULL CHECK(compatibility_hash ~ '^sha256:[0-9a-f]{64}$'), runtime_limit INTEGER NOT NULL CHECK(runtime_limit=1),
  state TEXT NOT NULL CHECK(state IN('installing','ready','revoked')), installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  execution_authority TEXT NOT NULL CHECK(execution_authority='execute_bounded'), lifecycle_decision_authority TEXT NOT NULL CHECK(lifecycle_decision_authority='none'),
  provider_human_authority TEXT NOT NULL CHECK(provider_human_authority='none'), merge_authority TEXT NOT NULL CHECK(merge_authority='none'),
  deployment_authority TEXT NOT NULL CHECK(deployment_authority='none'), production_authority TEXT NOT NULL CHECK(production_authority='none')
);
ALTER TABLE rorca.runtime_events ADD COLUMN federated_idempotency_key TEXT;
CREATE UNIQUE INDEX runtime_events_federated_idempotency_idx
  ON rorca.runtime_events(workspace_id,federated_idempotency_key) WHERE federated_idempotency_key IS NOT NULL;
CREATE OR REPLACE VIEW rorca_canonical_api.runtime_events AS
  SELECT * FROM rorca.runtime_events WHERE workspace_id=current_setting('rorca.workspace_id',TRUE);

INSERT INTO rorca.wave4_federation_readiness(singleton,reviewed_wave2_sha,reviewed_wave3_sha,wave3a_spec_revision,wave3b_spec_revision,
  wave2_migration_head,wave3a_migration_head,wave3b_migration_head,wave2_prerequisite_receipt_hash,contract_version,
  conformance_receipt_hash,independent_review_receipt_hash,wave3_security_review_receipt_hash,wave3_release_review_receipt_hash,
  wave3_security_reviewer_id,wave3_release_reviewer_id,wave3_security_verdict,wave3_release_verdict,
  wave3_security_finding_count,wave3_release_finding_count,reviewed_wave3_tree_sha,
  compatibility_hash,runtime_limit,state,execution_authority,lifecycle_decision_authority,provider_human_authority,merge_authority,deployment_authority,production_authority)
SELECT TRUE,'1420fb4c819aad692894da9449bc4958ed74dd49','a66537fc3a5607a80f6b1010ebdde238d3b6ce8f',
  'sha256:249b8fc33c6223acd63549f28c59714dfe3212df3b4d00572f9aef2e2252060d','sha256:992cdad5119b7f4e359d3839665d10a9dd19aeec4fbdec6e2bf895c6f5e9ddd4',
  20260731157000,20260804182000,20260805100000,w.prerequisite_receipt_hash,'1.0.0',
  'sha256:c998212b90ef90d3c6aabd3f26c2a2ecf15a7df4fecea44c5a663b4bf159a5c4',
  'sha256:4e9ef68f52918a33471b04dab4a084a177d0b5b5289aae12c622d7977459edeb',
  'sha256:dc093ac2fbed1642b6203541828503d90539d8cb7aea4b15f37409e58edaf8d0',
  'sha256:51cca9d2ed931e2f482f180f57ae50197a7b0ba20a9c72c330ab5300311d295f',
  'Wave3SecFinal2','Wave3RelFinal2','accepted','accepted',0,0,'a8bea27e85c9340d69ed078cd15a9dbfdc586abd',
  'sha256:'||encode(digest(convert_to('wave2:1420fb4c819aad692894da9449bc4958ed74dd49|wave3:a66537fc3a5607a80f6b1010ebdde238d3b6ce8f|contract:1.0.0','UTF8'),'sha256'),'hex'),
  1,'installing','execute_bounded','none','none','none','none','none'
FROM rorca.wave2_schema_readiness w JOIN rorca.wave2_effective_readiness e
  ON e.prerequisite_receipt_hash=w.prerequisite_receipt_hash
WHERE w.singleton=TRUE AND w.state='ready' AND w.migration_version=20260731157000 AND e.ready=TRUE;

CREATE TABLE rorca.federated_runtime_profiles (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  runtime_id TEXT NOT NULL, endpoint TEXT NOT NULL CHECK(endpoint ~ '^https://'), allowed_contract_versions JSONB NOT NULL CHECK(allowed_contract_versions='["1.0.0"]'::jsonb),
  allowed_paths JSONB NOT NULL CHECK(jsonb_typeof(allowed_paths)='array' AND jsonb_array_length(allowed_paths)<=500),
  mutation_bounds_hash TEXT NOT NULL CHECK(mutation_bounds_hash ~ '^sha256:[0-9a-f]{64}$'), current_credential_version INTEGER NOT NULL CHECK(current_credential_version>0),
  current_key_version INTEGER NOT NULL CHECK(current_key_version>0), status TEXT NOT NULL CHECK(status IN('active','disabled','revoked')),
  expires_at TIMESTAMPTZ NOT NULL, audit_provenance_hash TEXT NOT NULL CHECK(audit_provenance_hash ~ '^sha256:[0-9a-f]{64}$'),
  registered_by TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,runtime_id), CHECK(endpoint !~* 'password|secret|token|credential|authorization'),
  CHECK(allowed_paths::text !~ '(^|/)\.\.(/|$)')
);
CREATE TABLE rorca.federated_runtime_credential_versions (
  workspace_id TEXT NOT NULL, runtime_id TEXT NOT NULL, credential_version INTEGER NOT NULL CHECK(credential_version>0), key_version INTEGER NOT NULL CHECK(key_version>0),
  credential_digest TEXT NOT NULL CHECK(credential_digest ~ '^sha256:[0-9a-f]{64}$'), expires_at TIMESTAMPTZ NOT NULL,
  audit_provenance_hash TEXT NOT NULL CHECK(audit_provenance_hash ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,runtime_id,credential_version), UNIQUE(workspace_id,runtime_id,key_version),
  FOREIGN KEY(workspace_id,runtime_id) REFERENCES rorca.federated_runtime_profiles(workspace_id,runtime_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.federated_runtime_identity_events (
  event_id BIGSERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, runtime_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN('registered','rotated','disabled','revoked','authentication_rejected')),
  credential_version INTEGER, key_version INTEGER, request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'), reason_code TEXT NOT NULL,
  provenance_hash TEXT NOT NULL CHECK(provenance_hash ~ '^sha256:[0-9a-f]{64}$'), database_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE rorca.federated_work_offers (
  workspace_id TEXT NOT NULL, offer_id TEXT NOT NULL, runtime_id TEXT NOT NULL, binding_hash TEXT NOT NULL CHECK(binding_hash ~ '^sha256:[0-9a-f]{64}$'),
  binding_json JSONB NOT NULL CHECK(jsonb_typeof(binding_json)='object' AND binding_json::text !~* 'context.?epoch|password|secret|credential|authorization|raw.?prompt|raw.?transcript|attestation|signature'),
  input_hash TEXT NOT NULL CHECK(input_hash ~ '^sha256:[0-9a-f]{64}$'), input_public_json JSONB NOT NULL CHECK(jsonb_typeof(input_public_json)='object' AND octet_length(input_public_json::text)<=5242880
    AND input_public_json::text !~* '"[^"]*(context.?epoch|password|secret|credential|raw.?prompt|raw.?transcript|human.?attestation|signature)[^"]*"[[:space:]]*:|"(authorization|raw.?authorization|authorization.?header|authorization.?value|raw.?authority|authority.?value)"[[:space:]]*:'),
  worktree_path TEXT NOT NULL, source_checkout_path TEXT NOT NULL, published_by TEXT NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL, state TEXT NOT NULL CHECK(state IN('eligible','claimed','expired','cancelled','quarantined')),
  PRIMARY KEY(workspace_id,offer_id), UNIQUE(workspace_id,binding_hash),
  FOREIGN KEY(workspace_id,runtime_id) REFERENCES rorca.federated_runtime_profiles(workspace_id,runtime_id) ON DELETE RESTRICT,
  CHECK(worktree_path<>source_checkout_path)
);
CREATE TABLE rorca.federated_execution_claims (
  workspace_id TEXT NOT NULL, claim_id UUID NOT NULL DEFAULT gen_random_uuid(), offer_id TEXT NOT NULL, runtime_id TEXT NOT NULL, binding_hash TEXT NOT NULL,
  binding_json JSONB NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'), idempotency_key TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK(generation>=0), session_id TEXT NOT NULL, session_file_hash TEXT NOT NULL CHECK(session_file_hash ~ '^sha256:[0-9a-f]{64}$'),
  turn_id TEXT NOT NULL, originating_generation BIGINT NOT NULL CHECK(originating_generation>=0),
  cursor BIGINT NOT NULL CHECK(cursor>=0), cursor_hash TEXT NOT NULL CHECK(cursor_hash ~ '^sha256:[0-9a-f]{64}$'),
  lease_id TEXT NOT NULL, fencing_token BIGINT NOT NULL CHECK(fencing_token>0), attempt_id TEXT NOT NULL, policy_activation_hash TEXT NOT NULL,
  bundle_hash TEXT NOT NULL, repository_id TEXT NOT NULL, base_sha TEXT NOT NULL, current_sha TEXT NOT NULL, expected_head_sha TEXT NOT NULL, worktree_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('active','released','cancelled','expired','result_proposed','closeout_pending','quarantined','conflicting')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,claim_id), UNIQUE(workspace_id,offer_id), UNIQUE(workspace_id,idempotency_key),
  FOREIGN KEY(workspace_id,offer_id) REFERENCES rorca.federated_work_offers(workspace_id,offer_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT,
  CHECK(binding_json::text !~* 'context.?epoch|password|secret|credential|authorization|raw.?prompt|raw.?transcript|attestation|signature')
);
CREATE UNIQUE INDEX federated_one_active_execution_idx ON rorca.federated_execution_claims((TRUE)) WHERE state='active';
CREATE TABLE rorca.federated_execution_events (
  event_id BIGSERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, claim_id UUID NOT NULL, event_type TEXT NOT NULL,
  prior_state TEXT, next_state TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL, database_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(workspace_id,claim_id) REFERENCES rorca.federated_execution_claims(workspace_id,claim_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.federated_result_proposals (
  workspace_id TEXT NOT NULL, proposal_id TEXT NOT NULL, claim_id UUID NOT NULL, proposal_hash TEXT NOT NULL CHECK(proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  proposal_json JSONB NOT NULL CHECK(jsonb_typeof(proposal_json)='object' AND octet_length(proposal_json::text)<=262144
    AND proposal_json::text !~* 'context.?epoch|password|secret|credential|authorization|raw.?prompt|raw.?transcript|attestation|signature'),
  host_verification_hash TEXT NOT NULL CHECK(host_verification_hash ~ '^sha256:[0-9a-f]{64}$'), host_verification_json JSONB NOT NULL,
  state TEXT NOT NULL CHECK(state IN('host_verified','closeout_pending','blocked','quarantined')), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,proposal_id), UNIQUE(workspace_id,claim_id), UNIQUE(workspace_id,proposal_hash),
  FOREIGN KEY(workspace_id,claim_id) REFERENCES rorca.federated_execution_claims(workspace_id,claim_id) ON DELETE RESTRICT,
  CHECK(host_verification_json->>'verified'='true' AND host_verification_json->>'hostEvidenceTrust'='host_observed'
    AND host_verification_json->>'runtimeClaimsTrust'='runtime_asserted' AND host_verification_json->>'closeoutAuthority'='none')
);
CREATE TABLE rorca.federated_recovery_decisions (
  recovery_id BIGSERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, claim_id UUID NOT NULL, request_hash TEXT NOT NULL CHECK(request_hash ~ '^sha256:[0-9a-f]{64}$'),
  classification TEXT NOT NULL CHECK(classification IN('resume_same_session_observation','await_cancellation_ack','terminal_no_relaunch','resume_shared_closeout','quarantined_ambiguity')),
  action TEXT NOT NULL CHECK(action IN('observe_only','deliver_cancellation','none','enqueue_closeout','preserve_and_block')),
  canonical_references_hash TEXT NOT NULL CHECK(canonical_references_hash ~ '^sha256:[0-9a-f]{64}$'), database_time TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,request_hash), FOREIGN KEY(workspace_id,claim_id) REFERENCES rorca.federated_execution_claims(workspace_id,claim_id) ON DELETE RESTRICT
);
CREATE TABLE rorca.federated_cancellation_deliveries (
  workspace_id TEXT NOT NULL, cancellation_id TEXT NOT NULL, claim_id UUID NOT NULL, runtime_id TEXT NOT NULL, generation BIGINT NOT NULL,
  lease_id TEXT NOT NULL, fencing_token BIGINT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','delivered','acknowledged','expired','conflicting')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5), next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deadline_at TIMESTAMPTZ NOT NULL, last_reason_code TEXT NOT NULL DEFAULT 'pending', updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,cancellation_id), FOREIGN KEY(workspace_id,claim_id) REFERENCES rorca.federated_execution_claims(workspace_id,claim_id) ON DELETE RESTRICT
);

CREATE TABLE rorca.federated_host_validation_observations (
  workspace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, validation_id TEXT NOT NULL,
  command_hash TEXT NOT NULL CHECK(command_hash ~ '^sha256:[0-9a-f]{64}$'),
  artifact_hash TEXT NOT NULL CHECK(artifact_hash ~ '^sha256:[0-9a-f]{64}$'),
  outcome TEXT NOT NULL CHECK(outcome IN('passed','failed')), observer_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,attempt_id,validation_id)
);
CREATE TABLE rorca.federated_host_artifact_observations (
  workspace_id TEXT NOT NULL, artifact_id TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(content_hash ~ '^sha256:[0-9a-f]{64}$'),
  byte_length BIGINT NOT NULL CHECK(byte_length BETWEEN 0 AND 67108864), restricted_reference_id TEXT NOT NULL,
  integrity_state TEXT NOT NULL CHECK(integrity_state IN('verified','corrupt','missing')), observer_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,artifact_id)
);

ALTER TABLE rorca.federated_host_validation_observations ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_host_validation_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.federated_host_artifact_observations ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_host_artifact_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.federated_runtime_profiles ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_runtime_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.federated_runtime_credential_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_runtime_credential_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.federated_runtime_identity_events ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_runtime_identity_events FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.federated_work_offers ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_work_offers FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.federated_execution_claims ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_execution_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.federated_execution_events ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_execution_events FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.federated_result_proposals ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_result_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.federated_recovery_decisions ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_recovery_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE rorca.federated_cancellation_deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE rorca.federated_cancellation_deliveries FORCE ROW LEVEL SECURITY;
DO $$ DECLARE table_name TEXT; BEGIN FOREACH table_name IN ARRAY ARRAY['federated_runtime_profiles','federated_runtime_credential_versions','federated_runtime_identity_events','federated_work_offers','federated_execution_claims','federated_execution_events','federated_result_proposals','federated_recovery_decisions','federated_cancellation_deliveries','federated_host_validation_observations','federated_host_artifact_observations'] LOOP
  EXECUTE format('CREATE POLICY %I ON rorca.%I FOR ALL USING(current_user IS DISTINCT FROM session_user) WITH CHECK(current_user IS DISTINCT FROM session_user)',table_name||'_definer_all',table_name);
END LOOP; END $$;
CREATE POLICY wave4_federation_activation_definer_read ON rorca.context_policy_activations
  FOR SELECT USING(current_user=pg_catalog.pg_get_userbyid((
    SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='rorca.context_policy_activations'::regclass)));
CREATE POLICY wave4_federation_activation_head_definer_read ON rorca.context_policy_activation_heads
  FOR SELECT USING(current_user=pg_catalog.pg_get_userbyid((
    SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='rorca.context_policy_activation_heads'::regclass)));
CREATE POLICY wave4_federation_activation_head_definer_lock ON rorca.context_policy_activation_heads
  FOR UPDATE USING(current_user=pg_catalog.pg_get_userbyid((
    SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='rorca.context_policy_activation_heads'::regclass)))
  WITH CHECK(current_user=pg_catalog.pg_get_userbyid((
    SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='rorca.context_policy_activation_heads'::regclass)));


CREATE FUNCTION rorca.wave4_require_writer_v1() RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
BEGIN IF session_user NOT IN(SELECT database_user FROM rorca.wave2_canonical_writer_identities) THEN RAISE EXCEPTION 'Canonical writer principal required' USING ERRCODE='42501'; END IF; END; $$;
CREATE FUNCTION rorca.load_wave4_federation_readiness_v1() RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
DECLARE result JSONB; BEGIN PERFORM rorca.wave4_require_writer_v1();
 SELECT to_jsonb(r)||jsonb_build_object('configured_runtime_ids',COALESCE((
   SELECT jsonb_agg(p.runtime_id ORDER BY p.runtime_id) FROM rorca.federated_runtime_profiles p
    WHERE p.status='active' AND p.expires_at>statement_timestamp()),'[]'::jsonb))
 INTO result FROM rorca.wave4_federation_readiness r
 WHERE r.singleton AND r.state='ready'
   AND r.reviewed_wave2_sha='1420fb4c819aad692894da9449bc4958ed74dd49'
   AND r.reviewed_wave3_sha='a66537fc3a5607a80f6b1010ebdde238d3b6ce8f'
   AND r.wave3a_spec_revision='sha256:249b8fc33c6223acd63549f28c59714dfe3212df3b4d00572f9aef2e2252060d'
   AND r.wave3b_spec_revision='sha256:992cdad5119b7f4e359d3839665d10a9dd19aeec4fbdec6e2bf895c6f5e9ddd4'
   AND r.wave2_migration_head=20260731157000 AND r.wave3a_migration_head=20260804182000
   AND r.wave3b_migration_head=20260805100000 AND r.contract_version='1.0.0'
   AND r.conformance_receipt_hash='sha256:c998212b90ef90d3c6aabd3f26c2a2ecf15a7df4fecea44c5a663b4bf159a5c4'
   AND r.wave3_security_review_receipt_hash='sha256:dc093ac2fbed1642b6203541828503d90539d8cb7aea4b15f37409e58edaf8d0'
   AND r.wave3_release_review_receipt_hash='sha256:51cca9d2ed931e2f482f180f57ae50197a7b0ba20a9c72c330ab5300311d295f'
   AND r.wave3_security_reviewer_id='Wave3SecFinal2' AND r.wave3_release_reviewer_id='Wave3RelFinal2'
   AND r.wave3_security_verdict='accepted' AND r.wave3_release_verdict='accepted'
   AND r.wave3_security_finding_count=0 AND r.wave3_release_finding_count=0
   AND r.reviewed_wave3_tree_sha='a8bea27e85c9340d69ed078cd15a9dbfdc586abd'
   AND EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness w JOIN rorca.wave2_effective_readiness e
     ON e.prerequisite_receipt_hash=w.prerequisite_receipt_hash
     WHERE w.singleton AND w.state='ready' AND w.migration_version=r.wave2_migration_head
       AND w.prerequisite_receipt_hash=r.wave2_prerequisite_receipt_hash AND e.ready=TRUE)
   AND EXISTS(SELECT 1 FROM rorca.wave3a_schema_readiness a WHERE a.singleton AND a.state='ready'
     AND a.migration_version=r.wave3a_migration_head AND a.wave2_implementation_git_sha=r.reviewed_wave2_sha)
   AND EXISTS(SELECT 1 FROM rorca.run_activity_schema_readiness b WHERE b.singleton AND b.state='ready'
     AND b.migration_version=r.wave3b_migration_head AND b.wave2_implementation_sha=r.reviewed_wave2_sha
     AND b.wave2_prerequisite_receipt_hash=r.wave2_prerequisite_receipt_hash)
   AND 3=(SELECT count(DISTINCT m.version) FROM public.schema_migrations m WHERE m.version IN
     (r.wave2_migration_head,r.wave3a_migration_head,r.wave3b_migration_head));
 RETURN result; END; $$;
CREATE FUNCTION rorca.register_wave4_federated_runtime_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE existing federated_runtime_profiles%ROWTYPE; request_hash TEXT:='sha256:'||encode(digest(convert_to(p::text,'UTF8'),'sha256'),'hex'); BEGIN
 PERFORM rorca.wave4_require_writer_v1(); PERFORM pg_advisory_xact_lock(hashtextextended('wave4-one-runtime',0));
 IF p->>'schemaVersion'<>'rorca.federated-runtime-registration.v1' OR p->>'status'<>'active' OR p->'allowedContractVersions'<>'["1.0.0"]'::jsonb
   OR (p->>'credentialDigest') !~ '^sha256:[0-9a-f]{64}$' OR (p->>'expiresAt')::timestamptz<=clock_timestamp()
   OR COALESCE((p->>'controlPlaneCredentials')::boolean,TRUE) OR COALESCE((p->>'databaseCredentials')::boolean,TRUE)
   OR COALESCE((p->>'githubCredentials')::boolean,TRUE) OR COALESCE((p->>'modelProviderCredentials')::boolean,TRUE)
   OR COALESCE((p->>'providerHumanCredentials')::boolean,TRUE) OR COALESCE((p->>'mergeAuthority')::boolean,TRUE) OR COALESCE((p->>'deploymentAuthority')::boolean,TRUE)
 THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','invalid_or_authority_widening_registration'); END IF;
 SELECT * INTO existing FROM rorca.federated_runtime_profiles WHERE singleton FOR UPDATE;
 IF FOUND THEN
   IF existing.workspace_id=p->>'workspaceId' AND existing.runtime_id=p->>'runtimeId' AND existing.endpoint=p->>'endpoint'
      AND existing.allowed_contract_versions=p->'allowedContractVersions' AND existing.allowed_paths=p->'allowedPaths'
      AND existing.mutation_bounds_hash=p->>'mutationBoundsHash' AND existing.current_credential_version=(p->>'credentialVersion')::int
      AND existing.current_key_version=(p->>'keyVersion')::int AND existing.expires_at=(p->>'expiresAt')::timestamptz
      AND existing.audit_provenance_hash=p->>'auditProvenanceHash' AND existing.registered_by=p->>'registeredBy'
      AND EXISTS(SELECT 1 FROM rorca.federated_runtime_credential_versions c WHERE c.workspace_id=existing.workspace_id AND c.runtime_id=existing.runtime_id
        AND c.credential_version=existing.current_credential_version AND c.key_version=existing.current_key_version
        AND c.credential_digest=p->>'credentialDigest' AND c.expires_at=(p->>'expiresAt')::timestamptz
        AND c.audit_provenance_hash=p->>'auditProvenanceHash')
   THEN RETURN jsonb_build_object('ok',TRUE,'duplicate',TRUE,'value',jsonb_build_object('runtimeId',existing.runtime_id,'workspaceId',existing.workspace_id,'credentialVersion',existing.current_credential_version)); END IF;
   RETURN jsonb_build_object('ok',FALSE,'reasonCode','second_runtime_or_changed_registration');
 END IF;
 INSERT INTO rorca.federated_runtime_profiles(singleton,workspace_id,runtime_id,endpoint,allowed_contract_versions,allowed_paths,mutation_bounds_hash,current_credential_version,current_key_version,status,expires_at,audit_provenance_hash,registered_by)
 VALUES(TRUE,p->>'workspaceId',p->>'runtimeId',p->>'endpoint',p->'allowedContractVersions',p->'allowedPaths',p->>'mutationBoundsHash',(p->>'credentialVersion')::int,(p->>'keyVersion')::int,'active',(p->>'expiresAt')::timestamptz,p->>'auditProvenanceHash',p->>'registeredBy');
 INSERT INTO rorca.federated_runtime_credential_versions(workspace_id,runtime_id,credential_version,key_version,credential_digest,expires_at,audit_provenance_hash)
 VALUES(p->>'workspaceId',p->>'runtimeId',(p->>'credentialVersion')::int,(p->>'keyVersion')::int,p->>'credentialDigest',(p->>'expiresAt')::timestamptz,p->>'auditProvenanceHash');
 INSERT INTO rorca.federated_runtime_identity_events(workspace_id,runtime_id,event_type,credential_version,key_version,request_hash,reason_code,provenance_hash)
 VALUES(p->>'workspaceId',p->>'runtimeId','registered',(p->>'credentialVersion')::int,(p->>'keyVersion')::int,request_hash,'registered',p->>'auditProvenanceHash');
 RETURN jsonb_build_object('ok',TRUE,'duplicate',FALSE,'value',jsonb_build_object('runtimeId',p->>'runtimeId','workspaceId',p->>'workspaceId','credentialVersion',(p->>'credentialVersion')::int));
END; $$;
CREATE FUNCTION rorca.rotate_wave4_federated_credential_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE profile federated_runtime_profiles%ROWTYPE; request_hash TEXT:='sha256:'||encode(digest(convert_to(p::text,'UTF8'),'sha256'),'hex'); BEGIN PERFORM rorca.wave4_require_writer_v1();
 SELECT * INTO profile FROM rorca.federated_runtime_profiles WHERE workspace_id=p->>'workspaceId' AND runtime_id=p->>'runtimeId' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','runtime_missing'); END IF;
 IF EXISTS(SELECT 1 FROM rorca.federated_runtime_credential_versions WHERE workspace_id=profile.workspace_id AND runtime_id=profile.runtime_id AND credential_version=(p->>'credentialVersion')::int) THEN
   IF profile.current_credential_version=(p->>'credentialVersion')::int
      AND EXISTS(SELECT 1 FROM rorca.federated_runtime_credential_versions c WHERE c.workspace_id=profile.workspace_id AND c.runtime_id=profile.runtime_id
        AND c.credential_version=(p->>'credentialVersion')::int AND c.key_version=(p->>'keyVersion')::int
        AND c.credential_digest=p->>'credentialDigest' AND c.expires_at=(p->>'expiresAt')::timestamptz
        AND c.audit_provenance_hash=p->>'auditProvenanceHash')
   THEN RETURN jsonb_build_object('ok',TRUE,'duplicate',TRUE,'value',jsonb_build_object('credentialVersion',profile.current_credential_version,'keyVersion',profile.current_key_version)); END IF;
   RETURN jsonb_build_object('ok',FALSE,'reasonCode','credential_replay_conflict'); END IF;
 IF profile.status<>'active' OR profile.current_credential_version<>(p->>'priorCredentialVersion')::int OR (p->>'credentialVersion')::int<>profile.current_credential_version+1
   OR (p->>'keyVersion')::int<=profile.current_key_version OR (p->>'expiresAt')::timestamptz<=clock_timestamp() THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','stale_or_invalid_rotation'); END IF;
 INSERT INTO rorca.federated_runtime_credential_versions(workspace_id,runtime_id,credential_version,key_version,credential_digest,expires_at,audit_provenance_hash)
 VALUES(profile.workspace_id,profile.runtime_id,(p->>'credentialVersion')::int,(p->>'keyVersion')::int,p->>'credentialDigest',(p->>'expiresAt')::timestamptz,p->>'auditProvenanceHash');
 UPDATE rorca.federated_runtime_profiles SET current_credential_version=(p->>'credentialVersion')::int,current_key_version=(p->>'keyVersion')::int,expires_at=(p->>'expiresAt')::timestamptz,audit_provenance_hash=p->>'auditProvenanceHash',updated_at=clock_timestamp() WHERE singleton;
 INSERT INTO rorca.federated_runtime_identity_events(workspace_id,runtime_id,event_type,credential_version,key_version,request_hash,reason_code,provenance_hash)
 VALUES(profile.workspace_id,profile.runtime_id,'rotated',(p->>'credentialVersion')::int,(p->>'keyVersion')::int,request_hash,'rotated',p->>'auditProvenanceHash');
 RETURN jsonb_build_object('ok',TRUE,'duplicate',FALSE,'value',jsonb_build_object('credentialVersion',(p->>'credentialVersion')::int,'keyVersion',(p->>'keyVersion')::int)); END; $$;
CREATE FUNCTION rorca.revoke_wave4_federated_runtime_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE profile federated_runtime_profiles%ROWTYPE; v_request_hash TEXT:='sha256:'||encode(digest(convert_to(p::text,'UTF8'),'sha256'),'hex'); BEGIN PERFORM rorca.wave4_require_writer_v1(); SELECT * INTO profile FROM rorca.federated_runtime_profiles WHERE workspace_id=p->>'workspaceId' AND runtime_id=p->>'runtimeId' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','runtime_missing'); END IF; IF profile.status='revoked' THEN
   IF EXISTS(SELECT 1 FROM rorca.federated_runtime_identity_events e WHERE e.workspace_id=profile.workspace_id AND e.runtime_id=profile.runtime_id AND e.event_type='revoked' AND e.request_hash=v_request_hash)
   THEN RETURN jsonb_build_object('ok',TRUE,'duplicate',TRUE,'value','{}'::jsonb); END IF;
   RETURN jsonb_build_object('ok',FALSE,'reasonCode','revocation_replay_conflict'); END IF;
 IF profile.current_credential_version<>(p->>'expectedCredentialVersion')::int THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','stale_credential_version'); END IF;
 UPDATE rorca.federated_runtime_profiles SET status='revoked',updated_at=clock_timestamp() WHERE singleton;
 UPDATE rorca.federated_execution_claims SET state='quarantined',updated_at=clock_timestamp() WHERE workspace_id=profile.workspace_id AND state='active';
 INSERT INTO rorca.federated_runtime_identity_events(workspace_id,runtime_id,event_type,credential_version,key_version,request_hash,reason_code,provenance_hash)
 VALUES(profile.workspace_id,profile.runtime_id,'revoked',profile.current_credential_version,profile.current_key_version,v_request_hash,p->>'reasonCode',p->>'provenanceHash'); RETURN jsonb_build_object('ok',TRUE,'value','{}'::jsonb); END; $$;
CREATE FUNCTION rorca.authenticate_wave4_federated_runtime_v1(p_workspace TEXT,p_runtime TEXT,p_credential_version INTEGER,p_key_version INTEGER,p_digest TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE result JSONB; BEGIN PERFORM rorca.wave4_require_writer_v1(); SELECT jsonb_build_object('runtimeId',r.runtime_id,'workspaceId',r.workspace_id,'credentialVersion',r.current_credential_version,'keyVersion',r.current_key_version,'status','active','allowedContractVersions',r.allowed_contract_versions,'mutationBoundsHash',r.mutation_bounds_hash)
 INTO result FROM rorca.federated_runtime_profiles r JOIN rorca.federated_runtime_credential_versions c ON c.workspace_id=r.workspace_id AND c.runtime_id=r.runtime_id AND c.credential_version=r.current_credential_version AND c.key_version=r.current_key_version
 WHERE r.workspace_id=p_workspace AND r.runtime_id=p_runtime AND r.status='active' AND r.expires_at>clock_timestamp() AND c.expires_at>clock_timestamp()
   AND r.current_credential_version=p_credential_version AND r.current_key_version=p_key_version AND c.credential_digest=p_digest; RETURN result; END; $$;
CREATE FUNCTION rorca.publish_wave4_federated_offer_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE existing federated_work_offers%ROWTYPE; b JSONB:=p->'binding'; BEGIN PERFORM rorca.wave4_require_writer_v1();
 IF p->>'schemaVersion'<>'rorca.federated-runtime.v1' OR p->>'inputHash' !~ '^sha256:[0-9a-f]{64}$' OR p->>'bindingHash' !~ '^sha256:[0-9a-f]{64}$'
   OR (p->>'expiresAt')::timestamptz<=clock_timestamp() OR p->>'worktreePath'=p->>'sourceCheckoutPath' THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','invalid_offer'); END IF;
 SELECT * INTO existing FROM rorca.federated_work_offers WHERE workspace_id=b->>'workspaceId' AND offer_id=p->>'offerId';
 IF FOUND THEN IF existing.input_hash=p->>'inputHash' THEN RETURN jsonb_build_object('ok',TRUE,'duplicate',TRUE,'value',jsonb_build_object('offerId',existing.offer_id,'bindingHash',existing.binding_hash)); END IF; RETURN jsonb_build_object('ok',FALSE,'reasonCode','changed_offer_replay'); END IF;
 IF NOT EXISTS(SELECT 1 FROM rorca.federated_runtime_profiles r WHERE r.workspace_id=b->>'workspaceId' AND r.runtime_id=b->>'runtimeId' AND r.status='active' AND r.expires_at>clock_timestamp())
   OR NOT EXISTS(SELECT 1 FROM rorca.execution_leases l WHERE l.workspace_id=b->>'workspaceId' AND l.lease_id=b->>'leaseId' AND l.attempt_id=b->>'attemptId' AND l.runtime_id=b->>'runtimeId'
    AND l.fencing_token=(b->>'fencingToken')::bigint AND l.state='active' AND l.expires_at=(b->>'expectedLeaseExpiresAt')::timestamptz AND l.expires_at>clock_timestamp()
    AND l.work_package_revision=(b->>'workPackageRevision')::int AND l.policy_activation_hash=b->>'policyActivationHash' AND l.checkpoint_hash=b->>'checkpointHash' AND l.bundle_hash=b->>'bundleHash'
    AND l.repository_id=b->>'repositoryId' AND l.base_sha=b->>'baseSha' AND l.current_sha=b->>'currentSha' AND l.worktree_id=b->>'worktreeId')
   OR EXISTS(SELECT 1 FROM rorca.governed_work_package_dependencies d
     WHERE d.workspace_id=b->>'workspaceId' AND d.mission_id=b->>'missionId' AND d.work_package_id=b->>'workPackageId'
       AND d.work_package_revision=(b->>'workPackageRevision')::int
       AND NOT EXISTS(SELECT 1 FROM rorca.governed_execution_attempts a
         JOIN rorca.governed_closeout_evaluations e ON e.workspace_id=a.workspace_id AND e.attempt_id=a.attempt_id
         WHERE a.workspace_id=d.workspace_id AND a.mission_id=d.mission_id AND a.work_package_id=d.dependency_work_package_id
           AND a.work_package_revision=d.dependency_revision AND e.outcome='eligible' AND e.story_closeout_decision_id IS NOT NULL))
 THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','canonical_lease_mismatch'); END IF;
 INSERT INTO rorca.federated_work_offers(workspace_id,offer_id,runtime_id,binding_hash,binding_json,input_hash,input_public_json,worktree_path,source_checkout_path,published_by,expires_at,state)
 VALUES(b->>'workspaceId',p->>'offerId',b->>'runtimeId',p->>'bindingHash',b,p->>'inputHash',p-ARRAY['worktreePath','sourceCheckoutPath'],p->>'worktreePath',p->>'sourceCheckoutPath',p->>'publishedBy',(p->>'expiresAt')::timestamptz,'eligible');
 RETURN jsonb_build_object('ok',TRUE,'duplicate',FALSE,'value',jsonb_build_object('offerId',p->>'offerId','bindingHash',p->>'bindingHash')); END; $$;
CREATE FUNCTION rorca.discover_wave4_federated_work_v1(p_workspace TEXT,p_runtime TEXT,p_limit INTEGER) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
DECLARE result JSONB; BEGIN PERFORM rorca.wave4_require_writer_v1(); IF NOT EXISTS(SELECT 1 FROM rorca.federated_runtime_profiles WHERE workspace_id=p_workspace AND runtime_id=p_runtime AND status='active' AND expires_at>clock_timestamp()) THEN RETURN jsonb_build_object('schemaVersion','rorca.federated-discovery.v1','offers','[]'::jsonb,'databaseTime',clock_timestamp()); END IF;
 SELECT jsonb_build_object('schemaVersion','rorca.federated-discovery.v1','offers',COALESCE(jsonb_agg(jsonb_build_object('offerId',o.offer_id,'bindingHash',o.binding_hash,'leaseId',o.binding_json->>'leaseId','workPackageId',o.binding_json->>'workPackageId','workPackageRevision',(o.binding_json->>'workPackageRevision')::int,'storyId',o.binding_json->>'storyId','expiresAt',o.expires_at) ORDER BY o.published_at),'[]'::jsonb),'databaseTime',clock_timestamp()) INTO result
 FROM (SELECT * FROM rorca.federated_work_offers offer WHERE offer.workspace_id=p_workspace AND offer.runtime_id=p_runtime AND offer.state='eligible' AND offer.expires_at>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM rorca.federated_execution_claims c WHERE c.workspace_id=p_workspace AND c.state='active') ORDER BY offer.published_at LIMIT LEAST(GREATEST(p_limit,1),10)) o; RETURN result; END; $$;
CREATE FUNCTION rorca.acquire_wave4_federated_work_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE offer federated_work_offers%ROWTYPE; claim federated_execution_claims%ROWTYPE; b JSONB:=p->'binding'; request_hash TEXT:='sha256:'||encode(digest(convert_to(p::text,'UTF8'),'sha256'),'hex'); BEGIN PERFORM rorca.wave4_require_writer_v1(); PERFORM pg_advisory_xact_lock(hashtextextended('wave4-one-active-execution',0));
 SELECT * INTO claim FROM rorca.federated_execution_claims WHERE workspace_id=b->>'workspaceId' AND idempotency_key=p->>'idempotencyKey'; IF FOUND THEN IF claim.request_hash=request_hash THEN RETURN jsonb_build_object('ok',TRUE,'duplicate',TRUE,'value',jsonb_build_object('claimId',claim.claim_id,'offerId',claim.offer_id,'bindingHash',claim.binding_hash,'leaseId',claim.lease_id,'fencingToken',claim.fencing_token,'databaseTime',claim.claimed_at)); END IF; RETURN jsonb_build_object('ok',FALSE,'reasonCode','changed_acquire_replay'); END IF;
 SELECT * INTO offer FROM rorca.federated_work_offers WHERE workspace_id=b->>'workspaceId' AND offer_id=p->>'offerId' FOR UPDATE;
 IF NOT FOUND OR offer.state<>'eligible' OR offer.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','offer_missing_or_ineligible'); END IF;
 IF offer.runtime_id<>b->>'runtimeId' OR offer.binding_hash<>p->>'bindingHash' OR offer.binding_json<>b THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','offer_binding_mismatch'); END IF;
 PERFORM 1 FROM rorca.context_policy_activation_heads h
  WHERE h.workspace_id=offer.workspace_id AND h.current_hash=b->>'policyActivationHash'
    AND h.effective_state='active' FOR KEY SHARE OF h;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','policy_activation_inactive'); END IF;
 IF EXISTS(SELECT 1 FROM rorca.federated_execution_claims WHERE state='active') OR NOT EXISTS(SELECT 1 FROM rorca.execution_leases l WHERE l.workspace_id=offer.workspace_id AND l.lease_id=b->>'leaseId' AND l.fencing_token=(b->>'fencingToken')::bigint AND l.runtime_id=offer.runtime_id AND l.state='active' AND l.expires_at=(b->>'expectedLeaseExpiresAt')::timestamptz AND l.expires_at>clock_timestamp()) THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','duplicate_execution_or_stale_lease'); END IF;
 INSERT INTO rorca.federated_execution_claims(workspace_id,offer_id,runtime_id,binding_hash,binding_json,request_hash,idempotency_key,generation,session_id,session_file_hash,turn_id,originating_generation,cursor,cursor_hash,lease_id,fencing_token,attempt_id,policy_activation_hash,bundle_hash,repository_id,base_sha,current_sha,expected_head_sha,worktree_id,state)
 VALUES(offer.workspace_id,offer.offer_id,offer.runtime_id,offer.binding_hash,b,request_hash,p->>'idempotencyKey',(p->>'generation')::bigint,p->>'sessionId',p->>'sessionFileHash',p->>'turnId',(p->>'originatingGeneration')::bigint,(p->>'cursor')::bigint,p->>'cursorHash',b->>'leaseId',(b->>'fencingToken')::bigint,b->>'attemptId',b->>'policyActivationHash',b->>'bundleHash',b->>'repositoryId',b->>'baseSha',b->>'currentSha',b->>'expectedHeadSha',b->>'worktreeId','active') RETURNING * INTO claim;
 UPDATE rorca.federated_work_offers SET state='claimed' WHERE workspace_id=offer.workspace_id AND offer_id=offer.offer_id;
 INSERT INTO rorca.federated_execution_events(workspace_id,claim_id,event_type,prior_state,next_state,request_hash,reason_code) VALUES(claim.workspace_id,claim.claim_id,'acquired','eligible','active',request_hash,'atomic_offer_claim');
 RETURN jsonb_build_object('ok',TRUE,'duplicate',FALSE,'value',jsonb_build_object('claimId',claim.claim_id,'offerId',claim.offer_id,'bindingHash',claim.binding_hash,'leaseId',claim.lease_id,'fencingToken',claim.fencing_token,'databaseTime',claim.claimed_at)); EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','duplicate_execution'); END; $$;
CREATE FUNCTION rorca.verify_wave4_federated_binding_v1(p_binding JSONB,p_generation BIGINT,p_session TEXT,p_cancellation_ack BOOLEAN DEFAULT FALSE,p_result_replay BOOLEAN DEFAULT FALSE) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE claim federated_execution_claims%ROWTYPE; lease execution_leases%ROWTYPE; BEGIN PERFORM rorca.wave4_require_writer_v1(); SELECT * INTO claim FROM rorca.federated_execution_claims WHERE workspace_id=p_binding->>'workspaceId' AND lease_id=p_binding->>'leaseId' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','claim_missing'); END IF;
 IF claim.binding_json<>p_binding OR claim.runtime_id<>p_binding->>'runtimeId' OR claim.generation<>p_generation OR claim.session_id<>p_session THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','exact_binding_or_session_mismatch'); END IF;
 IF NOT p_cancellation_ack THEN
   PERFORM 1 FROM rorca.context_policy_activation_heads h
    WHERE h.workspace_id=claim.workspace_id AND h.current_hash=p_binding->>'policyActivationHash'
      AND h.effective_state='active' FOR KEY SHARE OF h;
   IF NOT FOUND THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','policy_activation_inactive'); END IF;
 END IF;
 SELECT * INTO lease FROM rorca.execution_leases WHERE workspace_id=claim.workspace_id AND lease_id=claim.lease_id;
 IF NOT p_cancellation_ack AND ((claim.state<>'active' AND NOT (p_result_replay AND claim.state='result_proposed')) OR NOT FOUND OR lease.state<>'active' OR lease.expires_at<=clock_timestamp() OR lease.fencing_token<>claim.fencing_token OR lease.runtime_id<>claim.runtime_id
   OR EXISTS(SELECT 1 FROM rorca.execution_cancellation_requests c WHERE c.workspace_id=claim.workspace_id AND c.lease_id=claim.lease_id AND c.state<>'conflicted')) THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','lease_expired_cancelled_or_fenced'); END IF;
 IF p_cancellation_ack AND NOT EXISTS(SELECT 1 FROM rorca.execution_cancellation_requests c WHERE c.workspace_id=claim.workspace_id AND c.lease_id=claim.lease_id AND c.fencing_token=claim.fencing_token) THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','cancellation_missing'); END IF;
 RETURN jsonb_build_object('ok',TRUE,'value',jsonb_build_object('claimId',claim.claim_id,'state',claim.state)); END; $$;
CREATE FUNCTION rorca.read_wave4_federated_work_input_v1(p_workspace TEXT,p_lease TEXT,p_generation BIGINT,p_session TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
DECLARE result JSONB; BEGIN PERFORM rorca.wave4_require_writer_v1(); SELECT o.input_public_json || jsonb_build_object('schemaVersion','rorca.federated-work-input.v1','cancellation',CASE WHEN c.cancellation_id IS NULL THEN NULL ELSE jsonb_build_object('cancellationId',c.cancellation_id,'deadlineAt',c.deadline_at,'reasonCode',c.reason_code) END)
 INTO result FROM rorca.federated_execution_claims x JOIN rorca.federated_work_offers o USING(workspace_id,offer_id) LEFT JOIN rorca.execution_cancellation_requests c ON c.workspace_id=x.workspace_id AND c.lease_id=x.lease_id AND c.fencing_token=x.fencing_token
 WHERE x.workspace_id=p_workspace AND x.lease_id=p_lease AND x.generation=p_generation AND x.session_id=p_session AND x.state='active'; RETURN result; END; $$;
CREATE FUNCTION rorca.load_wave4_federated_allowed_paths_v1(p_workspace TEXT,p_lease TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
DECLARE result JSONB; BEGIN PERFORM rorca.wave4_require_writer_v1(); SELECT input_public_json#>'{workPackage,allowedPaths}' INTO result FROM rorca.federated_work_offers o JOIN rorca.federated_execution_claims c USING(workspace_id,offer_id) WHERE c.workspace_id=p_workspace AND c.lease_id=p_lease; RETURN result; END; $$;
CREATE FUNCTION rorca.verify_wave4_federated_host_validation_v1(p_workspace TEXT,p_attempt TEXT,p_validation TEXT,p_command_hash TEXT,p_artifact_hash TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
BEGIN PERFORM rorca.wave4_require_writer_v1(); RETURN EXISTS(SELECT 1 FROM rorca.federated_host_validation_observations
 WHERE workspace_id=p_workspace AND attempt_id=p_attempt AND validation_id=p_validation AND command_hash=p_command_hash
   AND artifact_hash=p_artifact_hash AND outcome='passed'); END; $$;
CREATE FUNCTION rorca.verify_wave4_federated_host_artifact_v1(p_workspace TEXT,p_artifact TEXT,p_content_hash TEXT,p_byte_length BIGINT,p_reference TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
BEGIN PERFORM rorca.wave4_require_writer_v1(); RETURN EXISTS(SELECT 1 FROM rorca.federated_host_artifact_observations
 WHERE workspace_id=p_workspace AND artifact_id=p_artifact AND content_hash=p_content_hash AND byte_length=p_byte_length
   AND restricted_reference_id=p_reference AND integrity_state='verified'); END; $$;
CREATE FUNCTION rorca.record_wave4_federated_host_validation_v1(p JSONB) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE existing federated_host_validation_observations%ROWTYPE; BEGIN PERFORM rorca.wave4_require_writer_v1();
 IF p->>'observerClass'<>'host' OR p->>'trustClass'<>'host_observed'
   OR NOT EXISTS(SELECT 1 FROM rorca.federated_execution_claims c WHERE c.workspace_id=p->>'workspaceId' AND c.attempt_id=p->>'attemptId' AND c.state='active')
 THEN RAISE EXCEPTION 'Exact active claim and host observer required' USING ERRCODE='42501'; END IF;
 SELECT * INTO existing FROM rorca.federated_host_validation_observations WHERE workspace_id=p->>'workspaceId' AND attempt_id=p->>'attemptId' AND validation_id=p->>'validationId';
 IF FOUND THEN IF existing.command_hash=p->>'commandHash' AND existing.artifact_hash=p->>'artifactHash' AND existing.outcome=p->>'outcome' THEN RETURN TRUE; END IF;
   RAISE EXCEPTION 'Changed host validation replay' USING ERRCODE='40001'; END IF;
 INSERT INTO rorca.federated_host_validation_observations(workspace_id,attempt_id,validation_id,command_hash,artifact_hash,outcome,observer_id)
 VALUES(p->>'workspaceId',p->>'attemptId',p->>'validationId',p->>'commandHash',p->>'artifactHash',p->>'outcome',p->>'observerId'); RETURN FALSE; END; $$;
CREATE FUNCTION rorca.record_wave4_federated_host_artifact_v1(p JSONB) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE existing federated_host_artifact_observations%ROWTYPE; BEGIN PERFORM rorca.wave4_require_writer_v1();
 IF p->>'observerClass'<>'host' OR p->>'trustClass'<>'host_observed' OR p->>'integrityState'<>'verified'
   OR NOT EXISTS(SELECT 1 FROM rorca.federated_execution_claims c WHERE c.workspace_id=p->>'workspaceId' AND c.state='active')
 THEN RAISE EXCEPTION 'Exact active claim and host observer required' USING ERRCODE='42501'; END IF;
 SELECT * INTO existing FROM rorca.federated_host_artifact_observations WHERE workspace_id=p->>'workspaceId' AND artifact_id=p->>'artifactId';
 IF FOUND THEN IF existing.content_hash=p->>'contentHash' AND existing.byte_length=(p->>'byteLength')::bigint AND existing.restricted_reference_id=p->>'restrictedReferenceId' THEN RETURN TRUE; END IF;
   RAISE EXCEPTION 'Changed host artifact replay' USING ERRCODE='40001'; END IF;
 INSERT INTO rorca.federated_host_artifact_observations(workspace_id,artifact_id,content_hash,byte_length,restricted_reference_id,integrity_state,observer_id)
 VALUES(p->>'workspaceId',p->>'artifactId',p->>'contentHash',(p->>'byteLength')::bigint,p->>'restrictedReferenceId','verified',p->>'observerId'); RETURN FALSE; END; $$;
CREATE FUNCTION rorca.load_wave4_federated_host_worktree_v1(p_workspace TEXT,p_worktree TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
DECLARE result JSONB; BEGIN PERFORM rorca.wave4_require_writer_v1(); SELECT jsonb_build_object('workspaceId',o.workspace_id,'worktreeId',o.binding_json->>'worktreeId','repositoryId',o.binding_json->>'repositoryId','worktreePath',o.worktree_path,'sourceCheckoutPath',o.source_checkout_path,'allowedPaths',o.input_public_json#>'{workPackage,allowedPaths}') INTO result FROM rorca.federated_work_offers o WHERE o.workspace_id=p_workspace AND o.binding_json->>'worktreeId'=p_worktree ORDER BY published_at DESC LIMIT 1; RETURN result; END; $$;
CREATE FUNCTION rorca.record_wave4_federated_lease_transition_v1(p_workspace TEXT,p_lease TEXT,p_transition TEXT,p_idempotency TEXT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE claim federated_execution_claims%ROWTYPE; prior TEXT; request_hash TEXT:='sha256:'||encode(digest(convert_to(jsonb_build_array(p_workspace,p_lease,p_transition,p_idempotency)::text,'UTF8'),'sha256'),'hex'); BEGIN PERFORM rorca.wave4_require_writer_v1(); IF p_transition='renewed' THEN RETURN TRUE; END IF; SELECT * INTO claim FROM rorca.federated_execution_claims WHERE workspace_id=p_workspace AND lease_id=p_lease FOR UPDATE; IF NOT FOUND THEN RETURN FALSE; END IF; prior:=claim.state; UPDATE rorca.federated_execution_claims SET state=CASE WHEN p_transition='released' THEN 'released' ELSE state END,updated_at=clock_timestamp() WHERE workspace_id=p_workspace AND claim_id=claim.claim_id; INSERT INTO rorca.federated_execution_events(workspace_id,claim_id,event_type,prior_state,next_state,request_hash,reason_code) VALUES(p_workspace,claim.claim_id,p_transition,prior,CASE WHEN p_transition='released' THEN 'released' ELSE prior END,request_hash,p_transition); RETURN TRUE; END; $$;
CREATE FUNCTION rorca.load_wave4_federated_result_replay_v1(p_workspace TEXT,p_proposal TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,rorca AS $$
DECLARE result JSONB; BEGIN PERFORM rorca.wave4_require_writer_v1();
 SELECT jsonb_build_object('proposalHash',proposal_hash,'hostVerification',host_verification_json)
   INTO result FROM rorca.federated_result_proposals
  WHERE workspace_id=p_workspace AND proposal_id=p_proposal;
 RETURN result; END; $$;

CREATE FUNCTION rorca.persist_wave4_federated_result_v1(p_proposal JSONB,p_host JSONB,p_proposal_hash TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE claim federated_execution_claims%ROWTYPE; existing federated_result_proposals%ROWTYPE; b JSONB:=p_proposal->'binding'; host_hash TEXT:='sha256:'||encode(digest(convert_to(p_host::text,'UTF8'),'sha256'),'hex'); BEGIN PERFORM rorca.wave4_require_writer_v1(); SELECT * INTO existing FROM rorca.federated_result_proposals WHERE workspace_id=b->>'workspaceId' AND proposal_id=p_proposal->>'proposalId'; IF FOUND THEN IF existing.proposal_hash=p_proposal_hash THEN RETURN jsonb_build_object('ok',TRUE,'duplicate',TRUE,'value',jsonb_build_object('duplicate',TRUE,'hostVerification',existing.host_verification_json)); END IF; RETURN jsonb_build_object('ok',FALSE,'reasonCode','changed_result_replay'); END IF;
 SELECT * INTO claim FROM rorca.federated_execution_claims WHERE workspace_id=b->>'workspaceId' AND lease_id=b->>'leaseId' FOR UPDATE;
 IF NOT FOUND OR claim.state<>'active' OR claim.binding_json<>b OR claim.generation<>(p_proposal->>'generation')::bigint OR claim.session_id<>p_proposal->>'sessionId'
   OR p_host->>'verified'<>'true' OR p_host->>'hostEvidenceTrust'<>'host_observed' OR p_host->>'runtimeClaimsTrust'<>'runtime_asserted' OR p_host->>'closeoutAuthority'<>'none'
   OR EXISTS(SELECT 1 FROM rorca.execution_cancellation_requests c WHERE c.workspace_id=claim.workspace_id AND c.lease_id=claim.lease_id)
   OR NOT EXISTS(SELECT 1 FROM rorca.execution_leases l WHERE l.workspace_id=claim.workspace_id AND l.lease_id=claim.lease_id AND l.state='active' AND l.expires_at>clock_timestamp() AND l.fencing_token=claim.fencing_token)
 THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','stale_cancelled_or_unverified_result'); END IF;
 PERFORM 1 FROM rorca.context_policy_activation_heads h
  WHERE h.workspace_id=claim.workspace_id AND h.current_hash=b->>'policyActivationHash'
    AND h.effective_state='active' FOR KEY SHARE OF h;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','policy_activation_inactive'); END IF;
 INSERT INTO rorca.federated_result_proposals(workspace_id,proposal_id,claim_id,proposal_hash,proposal_json,host_verification_hash,host_verification_json,state)
 VALUES(claim.workspace_id,p_proposal->>'proposalId',claim.claim_id,p_proposal_hash,p_proposal,host_hash,p_host,'host_verified'); UPDATE rorca.federated_execution_claims SET state='result_proposed',updated_at=clock_timestamp() WHERE workspace_id=claim.workspace_id AND claim_id=claim.claim_id;
 INSERT INTO rorca.federated_execution_events(workspace_id,claim_id,event_type,prior_state,next_state,request_hash,reason_code) VALUES(claim.workspace_id,claim.claim_id,'result_proposed','active','result_proposed',p_proposal_hash,'host_verified_proposal_only'); RETURN jsonb_build_object('ok',TRUE,'duplicate',FALSE,'value',jsonb_build_object('duplicate',FALSE,'hostVerification',p_host)); END; $$;
CREATE FUNCTION rorca.reconcile_wave4_federated_runtime_v1(p JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE claim federated_execution_claims%ROWTYPE; classification TEXT; action TEXT; v_request_hash TEXT:='sha256:'||encode(digest(convert_to(p::text,'UTF8'),'sha256'),'hex'); refs TEXT; existing federated_recovery_decisions%ROWTYPE; BEGIN PERFORM rorca.wave4_require_writer_v1();
 SELECT * INTO claim FROM rorca.federated_execution_claims WHERE workspace_id=p#>>'{binding,workspaceId}' AND lease_id=p#>>'{binding,leaseId}' FOR UPDATE;
 IF NOT FOUND OR claim.binding_json<>p->'binding' OR claim.runtime_id<>p#>>'{binding,runtimeId}' OR claim.generation<>(p->>'generation')::bigint OR claim.session_id<>p->>'sessionId' OR claim.session_file_hash<>p->>'sessionFileHash' OR claim.turn_id<>p->>'turnId' OR claim.originating_generation<>(p->>'originatingGeneration')::bigint OR claim.cursor<>(p->>'cursor')::bigint OR claim.cursor_hash<>p->>'cursorHash' OR claim.bundle_hash<>p->>'bundleHash' THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','recovery_identity_mismatch'); END IF;
 PERFORM 1 FROM rorca.context_policy_activation_heads h
 WHERE h.workspace_id=claim.workspace_id AND h.activation_id=p#>>'{binding,policyActivationId}'
  AND h.current_revision=(p#>>'{binding,policyActivationRevision}')::bigint
  AND h.current_hash=p#>>'{binding,policyActivationHash}' AND h.effective_state='active' FOR KEY SHARE OF h;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',FALSE,'reasonCode','policy_activation_inactive'); END IF;
 SELECT * INTO existing FROM rorca.federated_recovery_decisions d
  WHERE d.workspace_id=p#>>'{binding,workspaceId}' AND d.request_hash=v_request_hash;
 IF FOUND THEN RETURN jsonb_build_object('ok',TRUE,'duplicate',TRUE,'value',
  jsonb_build_object('classification',existing.classification,'action',existing.action,
    'canonicalReferencesHash',existing.canonical_references_hash)); END IF;
 IF claim.state IN('result_proposed','closeout_pending') THEN classification:='resume_shared_closeout';action:='enqueue_closeout';
 ELSIF EXISTS(SELECT 1 FROM rorca.execution_cancellation_requests c WHERE c.workspace_id=claim.workspace_id AND c.lease_id=claim.lease_id) THEN classification:='await_cancellation_ack';action:='deliver_cancellation';
 ELSIF claim.state IN('released','cancelled','expired') OR NOT EXISTS(SELECT 1 FROM rorca.execution_leases l WHERE l.workspace_id=claim.workspace_id AND l.lease_id=claim.lease_id AND l.state='active' AND l.expires_at>clock_timestamp()) THEN classification:='terminal_no_relaunch';action:='none';
 ELSIF claim.state='active' THEN classification:='resume_same_session_observation';action:='observe_only';
 ELSE classification:='quarantined_ambiguity';action:='preserve_and_block'; UPDATE rorca.federated_execution_claims SET state='quarantined',updated_at=clock_timestamp() WHERE workspace_id=claim.workspace_id AND claim_id=claim.claim_id; END IF;
 refs:='sha256:'||encode(digest(convert_to(jsonb_build_object('claimId',claim.claim_id,'leaseId',claim.lease_id,'fencingToken',claim.fencing_token,'policyActivationHash',claim.policy_activation_hash,'bundleHash',claim.bundle_hash,'repositoryId',claim.repository_id,'baseSha',claim.base_sha,'currentSha',claim.current_sha,'worktreeId',claim.worktree_id,'state',claim.state)::text,'UTF8'),'sha256'),'hex');
 INSERT INTO rorca.federated_recovery_decisions(workspace_id,claim_id,request_hash,classification,action,canonical_references_hash) VALUES(claim.workspace_id,claim.claim_id,v_request_hash,classification,action,refs);
 RETURN jsonb_build_object('ok',TRUE,'duplicate',FALSE,'value',jsonb_build_object('classification',classification,'action',action,'canonicalReferencesHash',refs,'relaunch',FALSE,'successInferred',FALSE)); END; $$;

CREATE FUNCTION rorca.wave4_cancellation_delivery_request_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$
DECLARE claim federated_execution_claims%ROWTYPE; BEGIN SELECT * INTO claim FROM rorca.federated_execution_claims WHERE workspace_id=NEW.workspace_id AND lease_id=NEW.lease_id AND fencing_token=NEW.fencing_token AND state IN('active','result_proposed','closeout_pending'); IF FOUND THEN INSERT INTO rorca.federated_cancellation_deliveries(workspace_id,cancellation_id,claim_id,runtime_id,generation,lease_id,fencing_token,deadline_at) VALUES(NEW.workspace_id,NEW.cancellation_id,claim.claim_id,claim.runtime_id,claim.generation,NEW.lease_id,NEW.fencing_token,NEW.deadline_at) ON CONFLICT DO NOTHING; END IF; RETURN NEW; END; $$;
CREATE TRIGGER wave4_cancellation_delivery_request AFTER INSERT ON rorca.execution_cancellation_requests FOR EACH ROW EXECUTE FUNCTION rorca.wave4_cancellation_delivery_request_v1();
CREATE FUNCTION rorca.wave4_cancellation_delivery_ack_v1() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$ BEGIN UPDATE rorca.federated_cancellation_deliveries SET state=CASE WHEN NEW.classification IN('accepted','duplicate') THEN 'acknowledged' ELSE 'conflicting' END,last_reason_code=NEW.classification,updated_at=clock_timestamp() WHERE workspace_id=NEW.workspace_id AND cancellation_id=NEW.cancellation_id; RETURN NEW; END; $$;
CREATE TRIGGER wave4_cancellation_delivery_ack AFTER INSERT ON rorca.execution_cancellation_acknowledgements FOR EACH ROW EXECUTE FUNCTION rorca.wave4_cancellation_delivery_ack_v1();

DO $$ DECLARE table_name TEXT; BEGIN FOREACH table_name IN ARRAY ARRAY['federated_runtime_credential_versions','federated_runtime_identity_events','federated_execution_events','federated_result_proposals','federated_recovery_decisions','federated_host_validation_observations','federated_host_artifact_observations'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation()',table_name||'_immutable',table_name);
 EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON rorca.%I FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate()',table_name||'_no_truncate',table_name);
END LOOP; END $$;

UPDATE rorca.wave4_federation_readiness r SET state='ready',installed_at=clock_timestamp() WHERE singleton AND state='installing'
  AND conformance_receipt_hash='sha256:c998212b90ef90d3c6aabd3f26c2a2ecf15a7df4fecea44c5a663b4bf159a5c4'
  AND wave3_security_verdict='accepted' AND wave3_release_verdict='accepted'
  AND wave3_security_finding_count=0 AND wave3_release_finding_count=0
  AND EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness w JOIN rorca.wave2_effective_readiness e
    ON e.prerequisite_receipt_hash=w.prerequisite_receipt_hash
    WHERE w.singleton AND w.state='ready' AND w.migration_version=20260731157000
      AND w.prerequisite_receipt_hash=r.wave2_prerequisite_receipt_hash AND e.ready=TRUE)
  AND EXISTS(SELECT 1 FROM rorca.wave3a_schema_readiness a WHERE a.singleton AND a.state='ready'
    AND a.migration_version=20260804182000 AND a.wave2_implementation_git_sha=r.reviewed_wave2_sha)
  AND EXISTS(SELECT 1 FROM rorca.run_activity_schema_readiness b WHERE b.singleton AND b.state='ready'
    AND b.migration_version=20260805100000 AND b.wave2_implementation_sha=r.reviewed_wave2_sha
    AND b.wave2_prerequisite_receipt_hash=r.wave2_prerequisite_receipt_hash);
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM rorca.wave4_federation_readiness WHERE singleton AND state='ready') THEN RAISE EXCEPTION 'Wave 4 exact Wave 2/Wave 3 readiness gate failed closed' USING ERRCODE='55000'; END IF; END $$;
CREATE TRIGGER wave4_readiness_immutable BEFORE UPDATE OR DELETE ON rorca.wave4_federation_readiness FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER wave4_readiness_no_truncate BEFORE TRUNCATE ON rorca.wave4_federation_readiness FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

REVOKE ALL PRIVILEGES ON rorca.wave4_federation_readiness,rorca.federated_runtime_profiles,rorca.federated_runtime_credential_versions,rorca.federated_runtime_identity_events,
  rorca.federated_work_offers,rorca.federated_execution_claims,rorca.federated_execution_events,rorca.federated_result_proposals,rorca.federated_recovery_decisions,rorca.federated_cancellation_deliveries,
  rorca.federated_host_validation_observations,rorca.federated_host_artifact_observations FROM PUBLIC,authenticated,anon;
DO $$ DECLARE fn TEXT; writer_user TEXT:=current_setting('rorca.canonical_writer_database_user',TRUE); BEGIN IF writer_user IS NULL OR writer_user='' THEN RAISE EXCEPTION 'Canonical writer principal setting is required' USING ERRCODE='42501'; END IF;
 FOREACH fn IN ARRAY ARRAY['wave4_require_writer_v1()','load_wave4_federation_readiness_v1()','register_wave4_federated_runtime_v1(jsonb)','rotate_wave4_federated_credential_v1(jsonb)','revoke_wave4_federated_runtime_v1(jsonb)',
 'authenticate_wave4_federated_runtime_v1(text,text,integer,integer,text)','publish_wave4_federated_offer_v1(jsonb)','discover_wave4_federated_work_v1(text,text,integer)','acquire_wave4_federated_work_v1(jsonb)',
 'verify_wave4_federated_binding_v1(jsonb,bigint,text,boolean,boolean)','read_wave4_federated_work_input_v1(text,text,bigint,text)','load_wave4_federated_allowed_paths_v1(text,text)','load_wave4_federated_host_worktree_v1(text,text)',
 'verify_wave4_federated_host_validation_v1(text,text,text,text,text)','verify_wave4_federated_host_artifact_v1(text,text,text,bigint,text)','record_wave4_federated_host_validation_v1(jsonb)','record_wave4_federated_host_artifact_v1(jsonb)','record_wave4_federated_lease_transition_v1(text,text,text,text)','load_wave4_federated_result_replay_v1(text,text)','persist_wave4_federated_result_v1(jsonb,jsonb,text)','reconcile_wave4_federated_runtime_v1(jsonb)'] LOOP EXECUTE format('REVOKE ALL ON FUNCTION rorca.%s FROM PUBLIC,authenticated,anon',fn); EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.%s TO %I',fn,writer_user); END LOOP; END $$;
