-- A claim is recovery ownership, not provider-send authority. Persist a short-
-- lived server authorization bound to exact claim/delivery/lease authority.
ALTER TABLE rorca.continuation_dispatch_outbox
  ADD COLUMN send_authorization_hash TEXT CHECK(send_authorization_hash IS NULL OR send_authorization_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN send_authorized_at TIMESTAMPTZ,
  ADD COLUMN send_authorization_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT continuation_dispatch_send_authorization_complete CHECK(
    (send_authorization_hash IS NULL AND send_authorized_at IS NULL AND send_authorization_expires_at IS NULL) OR
    (send_authorization_hash IS NOT NULL AND send_authorized_at IS NOT NULL AND send_authorization_expires_at>send_authorized_at)
  );

UPDATE rorca.wave2_schema_readiness SET migration_version=20260729146000,installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729145000
 AND contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready' AND migration_version=20260729146000) THEN
  RAISE EXCEPTION 'Wave 2 dispatch-send readiness transition failed closed' USING ERRCODE='55000';
 END IF;
END $$;
