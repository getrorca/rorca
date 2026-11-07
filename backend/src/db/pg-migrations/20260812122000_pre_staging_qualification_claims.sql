/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

-- A qualification command may start only after a durable, workspace-bound claim.
-- Expired executing claims are terminally blocked rather than replayed because a
-- crashed worker cannot prove that the prior command had no external side effect.
CREATE TABLE IF NOT EXISTS ssdlc_qualification_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  spec_slug TEXT NOT NULL CHECK (btrim(spec_slug) <> ''),
  preview_hash TEXT NOT NULL CHECK (preview_hash ~ '^sha256:[0-9a-f]{64}$'),
  run_id BIGINT REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL CHECK (btrim(actor_id) <> ''),
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 256),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'executing', 'results_ready', 'complete', 'blocked')),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  checkout_sha TEXT CHECK (checkout_sha IS NULL OR checkout_sha ~ '^[0-9a-f]{40,64}$'),
  toolchain_digest TEXT CHECK (toolchain_digest IS NULL OR toolchain_digest ~ '^sha256:[0-9a-f]{64}$'),
  dependency_digest TEXT CHECK (dependency_digest IS NULL OR dependency_digest ~ '^sha256:[0-9a-f]{64}$'),
  sandbox_digest TEXT CHECK (sandbox_digest IS NULL OR sandbox_digest ~ '^sha256:[0-9a-f]{64}$'),
  result_payload JSONB CHECK (result_payload IS NULL OR jsonb_typeof(result_payload) = 'object'),
  result_hash TEXT CHECK (result_hash IS NULL OR result_hash ~ '^sha256:[0-9a-f]{64}$'),
  receipt_id UUID REFERENCES ssdlc_release_qualifications(id) ON DELETE RESTRICT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT ssdlc_qualification_attempt_idempotency_unique UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT ssdlc_qualification_attempt_lease_shape CHECK (
    (state = 'pending' AND lease_token IS NULL AND lease_expires_at IS NULL AND receipt_id IS NULL AND completed_at IS NULL AND result_payload IS NULL)
    OR (state = 'executing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND receipt_id IS NULL AND completed_at IS NULL AND result_payload IS NULL)
    OR (state = 'results_ready' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND receipt_id IS NULL AND completed_at IS NULL AND result_payload IS NOT NULL AND result_hash IS NOT NULL)
    OR (state = 'complete' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND receipt_id IS NOT NULL AND completed_at IS NOT NULL AND error_code IS NULL AND result_payload IS NOT NULL AND result_hash IS NOT NULL)
    OR (state = 'blocked' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND receipt_id IS NULL AND completed_at IS NOT NULL AND error_code IS NOT NULL)
  ),
  CONSTRAINT ssdlc_qualification_attempt_identity_before_completion CHECK (
    state NOT IN ('complete') OR
    (checkout_sha IS NOT NULL AND toolchain_digest IS NOT NULL AND dependency_digest IS NOT NULL AND sandbox_digest IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ssdlc_qualification_attempt_recovery
  ON ssdlc_qualification_attempts (state, lease_expires_at)
  WHERE state IN ('pending', 'executing');

-- API acquisition/polling and worker lease/completion share the configured
-- runtime pool. Keep the attempt ledger unavailable to request roles and grant
-- only the DML exercised by those two paths; UUID generation uses no sequence.
REVOKE ALL PRIVILEGES ON rorca.ssdlc_qualification_attempts FROM PUBLIC;

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
DECLARE writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = '' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user THEN
    RAISE EXCEPTION 'rorca.canonical_writer_database_user must identify a distinct finalizer principal';
  END IF;
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON rorca.ssdlc_qualification_attempts TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT SELECT, UPDATE ON rorca.ssdlc_qualification_attempts TO %I',
    writer_user
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON rorca.ssdlc_release_qualifications TO %I',
    writer_user
  );
END $$;
