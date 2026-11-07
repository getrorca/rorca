-- Grant the internal runtime only the operational capabilities used by the
-- bounded bounty restart reconciler. Schema ownership and immutable audit facts
-- remain migration-owner controlled.
DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = '' OR runtime_user = current_user THEN
    RAISE EXCEPTION 'A distinct runtime database principal is required'
      USING ERRCODE = '42501';
  END IF;

  EXECUTE format(
    'GRANT SELECT ON TABLE rorca.bounty_missions, rorca.bounty_operations, rorca.bounty_effect_reservations, rorca.bounty_application_outbox, rorca.bounty_leases, rorca.bounty_work_packages, rorca.bounty_worker_processes, rorca.bounty_holds TO %I',
    runtime_user
  );
  EXECUTE format('GRANT UPDATE (state) ON TABLE rorca.bounty_missions TO %I', runtime_user);
  EXECUTE format('GRANT UPDATE (state) ON TABLE rorca.bounty_operations TO %I', runtime_user);
  EXECUTE format('GRANT UPDATE (released_at) ON TABLE rorca.bounty_effect_reservations TO %I', runtime_user);
  EXECUTE format('GRANT UPDATE (cancelled_at, cancellation_reason) ON TABLE rorca.bounty_application_outbox TO %I', runtime_user);
  EXECUTE format('GRANT UPDATE (expires_at) ON TABLE rorca.bounty_leases TO %I', runtime_user);
  EXECUTE format('GRANT UPDATE (state) ON TABLE rorca.bounty_worker_processes TO %I', runtime_user);
  EXECUTE format('GRANT INSERT (workspace_id, mission_id, reason) ON TABLE rorca.bounty_holds TO %I', runtime_user);
END;
$$;
