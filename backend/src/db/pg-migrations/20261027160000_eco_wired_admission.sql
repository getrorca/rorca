-- Additive provenance, not accepted artifact or human decision authority.
SET LOCAL lock_timeout='5s';
CREATE TABLE eco_managed_closeout_links (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 run_id INTEGER NOT NULL REFERENCES eco_managed_run_bindings(run_id),
 closeout_event_id INTEGER NOT NULL REFERENCES wal_events(id),
 content_hash TEXT NOT NULL,
 canonical_bytes TEXT NOT NULL,
 PRIMARY KEY(workspace_id,run_id),
 CHECK(content_hash='sha256:'||encode(digest(convert_to(canonical_bytes,'UTF8'),'sha256'),'hex'))
);
ALTER TABLE eco_managed_closeout_links ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION guard_eco_closeout_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM eco_managed_run_bindings binding
  JOIN eco_phase_work_revisions revision ON revision.workspace_id=binding.workspace_id AND revision.phase_work_id=binding.phase_work_id AND revision.revision=binding.revision
  JOIN pipeline_runs run ON run.id=binding.run_id AND run.workspace_id=binding.workspace_id
  JOIN wal_events wal ON wal.id=run.host_closeout_event_id AND wal.id=NEW.closeout_event_id AND wal.workspace_id=run.workspace_id AND wal.canonical_run_id=run.id
  WHERE binding.run_id=NEW.run_id AND binding.workspace_id=NEW.workspace_id
   AND wal.event_type='run_closeout' AND wal.trust_provenance='host' AND wal.trusted_source='worker'
   AND (wal.payload::jsonb->>'run_id')::integer=run.id
   AND NEW.canonical_bytes::jsonb=jsonb_build_object(
    'phaseHash',binding.phase_hash,'sourceSetHash',revision.source_set_hash,'recipeHash',revision.recipe_hash,
    'parentHash',revision.canonical_body->'parentBinding'->>'planHash','phaseWorkId',binding.phase_work_id,
    'revision',binding.revision,'runId',run.id,'closeoutEventId',wal.id,'closeoutIdentityHash',wal.event_identity_hash)) THEN
  RAISE EXCEPTION 'Managed closeout requires exact scoped canonical host evidence and pins';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER eco_closeout_link_identity BEFORE INSERT ON eco_managed_closeout_links
 FOR EACH ROW EXECUTE FUNCTION guard_eco_closeout_link();
CREATE POLICY eco_workspace ON eco_managed_closeout_links
 USING(workspace_id=current_setting('rorca.workspace_id',TRUE))
 WITH CHECK(workspace_id=current_setting('rorca.workspace_id',TRUE));
REVOKE ALL ON eco_managed_closeout_links FROM PUBLIC;
DO $$ DECLARE runtime_user TEXT:=current_setting('rorca.runtime_database_user',TRUE); BEGIN
 IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'Explicit runtime database principal required'; END IF;
 EXECUTE format('GRANT SELECT,INSERT ON eco_managed_closeout_links TO %I',runtime_user);
END $$;
CREATE TRIGGER eco_closeout_immutable BEFORE UPDATE OR DELETE ON eco_managed_closeout_links
 FOR EACH ROW EXECUTE FUNCTION guard_eco_phase_work_immutable();
CREATE TRIGGER eco_closeout_no_truncate BEFORE TRUNCATE ON eco_managed_closeout_links
 FOR EACH STATEMENT EXECUTE FUNCTION guard_eco_phase_work_immutable();
-- Prevent a promotion/retry/recovery update from stripping the managed selector
-- and falling through to the legacy worker. Historical unmarked runs unchanged.
CREATE FUNCTION guard_eco_run_transport_pins() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.trigger_options ? 'ecoManagedAdmission' AND
  ((OLD.trigger_options->'ecoManagedAdmission',OLD.trigger_options->'phaseWorkBinding',OLD.trigger_options->'lifecycleDispatchClaim')
   IS DISTINCT FROM
   (NEW.trigger_options->'ecoManagedAdmission',NEW.trigger_options->'phaseWorkBinding',NEW.trigger_options->'lifecycleDispatchClaim')) THEN
  RAISE EXCEPTION 'Managed run transport pins are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER eco_run_transport_pins BEFORE UPDATE ON pipeline_runs
 FOR EACH ROW EXECUTE FUNCTION guard_eco_run_transport_pins();
