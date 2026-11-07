-- Canonical pipeline_runs uses BIGINT and a date-derived sequence above int32.
-- Widen only reference types; retain every FK, RLS, immutable and budget guard.
SET LOCAL lock_timeout = '5s';
ALTER TABLE eco_managed_roots
 ALTER COLUMN root_run_id TYPE BIGINT,
 ALTER COLUMN current_run_id TYPE BIGINT;
ALTER TABLE eco_managed_run_bindings
 ALTER COLUMN run_id TYPE BIGINT,
 ALTER COLUMN predecessor_run_id TYPE BIGINT;
ALTER TABLE eco_managed_usage_events ALTER COLUMN run_id TYPE BIGINT;
ALTER TABLE eco_managed_closeout_links ALTER COLUMN run_id TYPE BIGINT;

CREATE OR REPLACE FUNCTION guard_eco_closeout_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM eco_managed_run_bindings binding
  JOIN eco_phase_work_revisions revision ON revision.workspace_id=binding.workspace_id AND revision.phase_work_id=binding.phase_work_id AND revision.revision=binding.revision
  JOIN pipeline_runs run ON run.id=binding.run_id AND run.workspace_id=binding.workspace_id
  JOIN wal_events wal ON wal.id=run.host_closeout_event_id AND wal.id=NEW.closeout_event_id AND wal.workspace_id=run.workspace_id AND wal.canonical_run_id=run.id
  WHERE binding.run_id=NEW.run_id AND binding.workspace_id=NEW.workspace_id
   AND wal.event_type='run_closeout' AND wal.trust_provenance='host' AND wal.trusted_source='worker'
   AND (wal.payload::jsonb->>'run_id')::bigint=run.id
   AND NEW.canonical_bytes::jsonb=jsonb_build_object(
    'phaseHash',binding.phase_hash,'sourceSetHash',revision.source_set_hash,'recipeHash',revision.recipe_hash,
    'parentHash',revision.canonical_body->'parentBinding'->>'planHash','phaseWorkId',binding.phase_work_id,
    'revision',binding.revision,'runId',run.id,'closeoutEventId',wal.id,'closeoutIdentityHash',wal.event_identity_hash)) THEN
  RAISE EXCEPTION 'Managed closeout requires exact scoped canonical host evidence and pins';
 END IF;
 RETURN NEW;
END $$;
