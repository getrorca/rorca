-- Additive activation-head CAS closes policy revocation semantics without mutating immutable activation revisions.

DROP INDEX IF EXISTS rorca.context_policy_one_active_scope;

CREATE TABLE rorca.context_policy_activation_heads (
  workspace_id TEXT NOT NULL,
  scope_key TEXT NOT NULL CHECK(scope_key ~ '^sha256:[0-9a-f]{64}$'),
  activation_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK(current_revision>0),
  current_hash TEXT NOT NULL CHECK(current_hash ~ '^sha256:[0-9a-f]{64}$'),
  effective_state TEXT NOT NULL CHECK(effective_state IN ('proposed','verified','active','superseded','rejected','revoked')),
  state_version BIGINT NOT NULL DEFAULT 1 CHECK(state_version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,scope_key),
  UNIQUE(workspace_id,activation_id),
  FOREIGN KEY(workspace_id,activation_id,current_revision)
    REFERENCES rorca.context_policy_activations(workspace_id,activation_id,activation_revision) ON DELETE RESTRICT
);

INSERT INTO rorca.context_policy_activation_heads
  (workspace_id,scope_key,activation_id,current_revision,current_hash,effective_state)
SELECT DISTINCT ON (workspace_id,scope_key)
  workspace_id,scope_key,activation_id,activation_revision,activation_hash,state
FROM rorca.context_policy_activations
ORDER BY workspace_id,scope_key,activation_revision DESC;

ALTER TABLE rorca.context_policy_activation_heads ENABLE ROW LEVEL SECURITY;
CREATE POLICY w2_workspace_member_context_policy_activation_heads ON rorca.context_policy_activation_heads
  USING (EXISTS (
    SELECT 1 FROM rorca.workspace_members wm
    WHERE wm.workspace_id=context_policy_activation_heads.workspace_id
      AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),
        (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM rorca.workspace_members wm
    WHERE wm.workspace_id=context_policy_activation_heads.workspace_id
      AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),
        (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))
  ));

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729133000, installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729132000
  AND contract_source_digest='sha256:4fb7606213db1f78df5e61829bfb6561a800088169b225d9e1262f7ab2de7b6f';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rorca.wave2_schema_readiness
    WHERE singleton=TRUE AND state='ready' AND migration_version=20260729133000
      AND contract_source_digest='sha256:4fb7606213db1f78df5e61829bfb6561a800088169b225d9e1262f7ab2de7b6f'
  ) THEN
    RAISE EXCEPTION 'Wave 2 activation-head readiness transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
