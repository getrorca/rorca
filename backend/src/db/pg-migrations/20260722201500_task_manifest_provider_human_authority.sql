-- Bind service-relayed TaskManifest execution to one exact provider-human command.
-- Application tables only; this migration never touches pgboss.*.

ALTER TABLE provider_human_authority_receipts
  DROP CONSTRAINT IF EXISTS provider_human_authority_receipts_purpose_check;
ALTER TABLE provider_human_authority_receipts
  ADD CONSTRAINT provider_human_authority_receipts_purpose_check CHECK (purpose IN (
    'authoring_plan_confirmation', 'spec_set_approval', 'retry_approval',
    'lifecycle_decision', 'task_manifest_dispatch'
  ));

ALTER TABLE task_manifest_run_lineage
  ADD COLUMN IF NOT EXISTS provider_human_receipt_id UUID
    REFERENCES provider_human_authority_receipts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_task_manifest_root_provider_human_receipt
  ON task_manifest_run_lineage(provider_human_receipt_id)
  WHERE parent_run_id IS NULL AND provider_human_receipt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_task_manifest_provider_human_receipt_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt provider_human_authority_receipts%ROWTYPE;
  parent_receipt UUID;
BEGIN
  IF NEW.provider_human_receipt_id IS NULL THEN
    IF NEW.parent_run_id IS NOT NULL THEN
      SELECT provider_human_receipt_id INTO parent_receipt
      FROM task_manifest_run_lineage
      WHERE run_id = NEW.parent_run_id;
      IF parent_receipt IS NOT NULL THEN
        RAISE EXCEPTION 'TaskManifest descendant cannot drop provider-human authority'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO receipt
  FROM provider_human_authority_receipts
  WHERE id = NEW.provider_human_receipt_id
  FOR SHARE;

  IF NOT FOUND
     OR receipt.workspace_id <> NEW.workspace_id
     OR receipt.purpose <> 'task_manifest_dispatch'
     OR receipt.target_hash <> NEW.manifest_hash
  THEN
    RAISE EXCEPTION 'TaskManifest provider-human receipt binding is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_run_id IS NOT NULL THEN
    SELECT provider_human_receipt_id INTO parent_receipt
    FROM task_manifest_run_lineage
    WHERE run_id = NEW.parent_run_id;
    IF parent_receipt IS DISTINCT FROM NEW.provider_human_receipt_id THEN
      RAISE EXCEPTION 'TaskManifest descendant differs from parent provider-human authority'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_manifest_provider_human_receipt_binding
  ON task_manifest_run_lineage;
CREATE TRIGGER trg_task_manifest_provider_human_receipt_binding
BEFORE INSERT ON task_manifest_run_lineage
FOR EACH ROW EXECUTE FUNCTION enforce_task_manifest_provider_human_receipt_binding();
