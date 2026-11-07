-- REA-008 forward repair: trigger records have table-specific row types, so
-- direct NEW.field references fail even in an unselected CASE branch. Inspect
-- the generic JSONB row projection instead and preserve the exact deny rule.

CREATE OR REPLACE FUNCTION rorca.reject_provider_credential_rotation_value()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  payload JSONB := to_jsonb(NEW);
  inspected TEXT;
BEGIN
  IF TG_TABLE_NAME = 'provider_credential_rotation_intents' THEN
    inspected := concat_ws(
      ' ',
      payload->>'target_binding_reference',
      payload->'intent_payload',
      payload->'intent_authority_payload',
      payload->'capture_result'
    );
  ELSE
    inspected := concat_ws(
      ' ',
      payload->>'target_binding_reference',
      payload->'provider_evidence',
      payload->'provenance'
    );
  END IF;

  IF inspected ~ '(^|[^[:alnum:]])((sk|rk)_(test|live)_[[:alnum:]]{8,}|whsec_[[:alnum:]]{8,})' THEN
    RAISE EXCEPTION 'credential-shaped values are forbidden in provider rotation metadata';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION rorca.reject_provider_credential_rotation_value() FROM PUBLIC;

DO $$
DECLARE
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF writer_user IS NOT NULL AND writer_user <> '' THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION rorca.reject_provider_credential_rotation_value() TO %I',
      writer_user
    );
  END IF;
END;
$$;
