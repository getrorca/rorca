-- Application-owned bounty job publication and worker fencing.
ALTER TABLE bounty_work_packages
  ADD COLUMN package_hash TEXT,
  ADD CONSTRAINT bounty_work_packages_package_hash_format
    CHECK (package_hash IS NULL OR package_hash ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE bounty_application_outbox
  ADD COLUMN queue_name TEXT NOT NULL DEFAULT 'bounty:control',
  ADD COLUMN job_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN contract_revision BIGINT,
  ADD COLUMN mission_epoch BIGINT,
  ADD COLUMN work_package_id UUID,
  ADD COLUMN package_hash TEXT,
  ADD COLUMN publish_owner TEXT,
  ADD COLUMN publish_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN publish_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_error TEXT,
  ADD CONSTRAINT bounty_outbox_fixed_queue CHECK (queue_name IN ('bounty:control','bounty:work','bounty:reconcile')),
  ADD CONSTRAINT bounty_outbox_package_hash_format CHECK (package_hash IS NULL OR package_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT bounty_outbox_work_package_fk FOREIGN KEY (workspace_id, work_package_id)
    REFERENCES bounty_work_packages(workspace_id, id),
  ADD CONSTRAINT bounty_outbox_job_identity UNIQUE (job_id);

ALTER TABLE bounty_application_outbox ALTER COLUMN queue_name DROP DEFAULT;
CREATE INDEX bounty_outbox_pending_idx ON bounty_application_outbox (created_at)
  WHERE published_at IS NULL;
