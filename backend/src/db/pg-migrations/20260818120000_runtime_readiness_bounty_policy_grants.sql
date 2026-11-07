-- Restore only the runtime capabilities required by health/version and the
-- authenticated bounty policy surface. The migration owner remains the sole
-- schema authority; no mutation capability is granted on the migration ledger
-- or immutable bounty promotion/audit history.
DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = '' OR runtime_user = current_user THEN
    RAISE EXCEPTION 'A distinct runtime database principal is required'
      USING ERRCODE = '42501';
  END IF;

  REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations FROM PUBLIC;
  EXECUTE format('GRANT SELECT(version, applied_at, filename, skipped_in_lite_mode) ON TABLE public.schema_migrations TO %I', runtime_user);

  REVOKE ALL PRIVILEGES ON TABLE
    rorca.bounty_feature_policy,
    rorca.bounty_feature_policy_audit,
    rorca.bounty_release_promotions,
    rorca.bounty_release_promotion_revocations
    FROM PUBLIC, authenticated, anon;

  EXECUTE format('GRANT SELECT ON TABLE rorca.bounty_feature_policy TO %I', runtime_user);
  EXECUTE format(
    'GRANT INSERT(singleton,state,mission_mode,revision,audit_identity,authority_source,updated_at,promotion_receipt_id) ON TABLE rorca.bounty_feature_policy TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT UPDATE(state,mission_mode,revision,audit_identity,authority_source,updated_at,promotion_receipt_id) ON TABLE rorca.bounty_feature_policy TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE rorca.bounty_release_promotions, rorca.bounty_release_promotion_revocations TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT INSERT(id,qualification_receipt_hash,source_sha,bindings,bindings_hash,signer_key_hash,signed_payload,signature,issued_at,expires_at,admitted_by) ON TABLE rorca.bounty_release_promotions TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT INSERT(previous_state,state,mission_mode,revision,audit_identity,authority_source,promotion_receipt_id) ON TABLE rorca.bounty_feature_policy_audit TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT USAGE ON SEQUENCE rorca.bounty_feature_policy_audit_id_seq TO %I',
    runtime_user
  );
END;
$$;
