-- Provider-human lifecycle receipts are single-use decision authority.
-- Revocation never returns a receipt to the available pool.
-- Application tables only; this migration never touches pgboss.*.

CREATE UNIQUE INDEX IF NOT EXISTS ux_ssdlc_decisions_provider_human_receipt_one_use
  ON ssdlc_decisions(provider_human_receipt_id)
  WHERE provider_human_receipt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_ssdlc_provider_human_receipt_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  receipt provider_human_authority_receipts%ROWTYPE;
BEGIN
  IF NEW.provider_human_receipt_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO receipt
  FROM provider_human_authority_receipts
  WHERE id = NEW.provider_human_receipt_id
  FOR UPDATE;

  IF NOT FOUND
     OR receipt.workspace_id <> NEW.workspace_id
     OR receipt.purpose <> 'lifecycle_decision'
     OR receipt.actor_id <> NEW.principal_id
     OR NEW.principal_type <> 'provider_human'
  THEN
    RAISE EXCEPTION 'provider-human lifecycle receipt binding is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ssdlc_provider_human_receipt_binding ON ssdlc_decisions;
CREATE TRIGGER trg_ssdlc_provider_human_receipt_binding
BEFORE INSERT ON ssdlc_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_ssdlc_provider_human_receipt_binding();
