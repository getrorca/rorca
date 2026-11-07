/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

-- Freeze the exact lifecycle plan/spec/request identity before a pipeline run,
-- worktree, hook, filesystem artifact, or transport publication can exist.
CREATE TABLE IF NOT EXISTS ssdlc_lifecycle_dispatch_claims (
  claim_id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  spec_hash TEXT NOT NULL CHECK (spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  compiled_plan_id BIGINT NOT NULL REFERENCES ssdlc_compiled_plans(id) ON DELETE RESTRICT,
  request_identity TEXT NOT NULL CHECK (length(btrim(request_identity)) BETWEEN 1 AND 512),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ssdlc_lifecycle_dispatch_claim_request_unique
    UNIQUE (workspace_id, request_identity),
  CONSTRAINT ssdlc_lifecycle_dispatch_claim_plan_identity_unique
    UNIQUE (claim_id, workspace_id, spec_slug, spec_hash, compiled_plan_id, request_identity, request_hash)
);

CREATE INDEX IF NOT EXISTS idx_ssdlc_lifecycle_dispatch_claim_plan
  ON ssdlc_lifecycle_dispatch_claims (workspace_id, spec_slug, compiled_plan_id);

CREATE OR REPLACE FUNCTION guard_ssdlc_lifecycle_dispatch_claim_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
    FROM ssdlc_compiled_plans plan
   WHERE plan.id = NEW.compiled_plan_id
     AND plan.workspace_id = NEW.workspace_id
     AND plan.spec_slug = NEW.spec_slug
     AND plan.is_current = TRUE
     AND plan.validation_status = 'validated'
     AND plan.provenance_json->>'specHash' = NEW.spec_hash
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifecycle dispatch claim requires the exact current validated plan';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ssdlc_lifecycle_dispatch_claim_insert
  ON ssdlc_lifecycle_dispatch_claims;
CREATE TRIGGER trg_ssdlc_lifecycle_dispatch_claim_insert
BEFORE INSERT ON ssdlc_lifecycle_dispatch_claims
FOR EACH ROW EXECUTE FUNCTION guard_ssdlc_lifecycle_dispatch_claim_insert();

CREATE OR REPLACE FUNCTION guard_ssdlc_lifecycle_dispatch_claim_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'lifecycle dispatch claims are immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_ssdlc_lifecycle_dispatch_claim_immutable
  ON ssdlc_lifecycle_dispatch_claims;
CREATE TRIGGER trg_ssdlc_lifecycle_dispatch_claim_immutable
BEFORE UPDATE OR DELETE ON ssdlc_lifecycle_dispatch_claims
FOR EACH ROW EXECUTE FUNCTION guard_ssdlc_lifecycle_dispatch_claim_immutable();

DROP TRIGGER IF EXISTS trg_ssdlc_lifecycle_dispatch_claim_immutable_truncate
  ON ssdlc_lifecycle_dispatch_claims;
CREATE TRIGGER trg_ssdlc_lifecycle_dispatch_claim_immutable_truncate
BEFORE TRUNCATE ON ssdlc_lifecycle_dispatch_claims
FOR EACH STATEMENT EXECUTE FUNCTION guard_ssdlc_lifecycle_dispatch_claim_immutable();

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = '' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  EXECUTE format(
    'GRANT SELECT, INSERT ON rorca.ssdlc_lifecycle_dispatch_claims TO %I',
    runtime_user
  );
END $$;
