-- Additive Wave 2 evidence subject closure after the public schema gained explicit spec/story lineage.
-- Preserve migration 20260729131000 bytes and update readiness only from its exact reviewed digest.

ALTER TABLE rorca.mission_control_idempotency
  ADD COLUMN response_json JSONB;
ALTER TABLE rorca.mission_control_idempotency
  ADD CONSTRAINT mission_control_idempotency_response_bound_ck CHECK (
    response_json IS NULL OR (octet_length(response_json::text)<=16384 AND response_json::text !~* 'password|secret|credential|prompt|transcript|attestation|signature')
  );

ALTER TABLE rorca.ssdlc_lifecycle_evidence
  ADD COLUMN governed_spec_id TEXT,
  ADD COLUMN governed_spec_version INTEGER,
  ADD COLUMN governed_spec_hash TEXT,
  ADD COLUMN governed_story_id TEXT,
  ADD COLUMN governed_story_version INTEGER,
  ADD COLUMN governed_story_hash TEXT;

ALTER TABLE rorca.ssdlc_lifecycle_evidence DROP CONSTRAINT ssdlc_wave2_complete_subject_ck;
ALTER TABLE rorca.ssdlc_lifecycle_evidence ADD CONSTRAINT ssdlc_wave2_complete_subject_ck CHECK (
  governed_contract_id IS NULL OR (
    governed_contract_id='rorca.evidence-envelope.v1' AND governed_contract_hash ~ '^sha256:[0-9a-f]{64}$'
    AND governed_mission_id IS NOT NULL AND governed_work_package_id IS NOT NULL
    AND governed_spec_id IS NOT NULL AND governed_spec_version > 0 AND governed_spec_hash ~ '^sha256:[0-9a-f]{64}$'
    AND governed_story_id IS NOT NULL AND governed_story_version > 0 AND governed_story_hash ~ '^sha256:[0-9a-f]{64}$'
    AND governed_attempt_id IS NOT NULL AND governed_lease_id IS NOT NULL AND governed_fencing_token > 0
    AND governed_activation_hash ~ '^sha256:[0-9a-f]{64}$' AND governed_checkpoint_id IS NOT NULL
    AND governed_repository_id IS NOT NULL AND governed_worktree_id IS NOT NULL AND governed_observer_id IS NOT NULL
  )
);

UPDATE rorca.wave2_schema_readiness
SET contract_source_digest='sha256:4fb7606213db1f78df5e61829bfb6561a800088169b225d9e1262f7ab2de7b6f',
    migration_version=20260729132000,
    installed_at=clock_timestamp()
WHERE singleton=TRUE
  AND state='ready'
  AND migration_version=20260729131000
  AND contract_source_digest='sha256:4006224b9a3b6e062b85aa85309fa7e5afd489f318f280f9b9f9780593e42a3f';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rorca.wave2_schema_readiness
    WHERE singleton=TRUE AND state='ready' AND migration_version=20260729132000
      AND contract_source_digest='sha256:4fb7606213db1f78df5e61829bfb6561a800088169b225d9e1262f7ab2de7b6f'
  ) THEN
    RAISE EXCEPTION 'Wave 2 contract source digest alignment failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
