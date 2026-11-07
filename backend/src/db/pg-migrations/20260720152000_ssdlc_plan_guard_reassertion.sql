-- Reassert the lifecycle-plan activation guard after all historical migration
-- and dirty-upgrade paths. Plan content remains immutable; only current-row
-- selection and the service-owned draft -> validated activation are admitted.

CREATE OR REPLACE FUNCTION guard_ssdlc_compiled_plan_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compiled plans are audit-retained and cannot be deleted';
  END IF;

  IF (to_jsonb(OLD) - ARRAY['is_current', 'updated_at']::text[])
       IS NOT DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['is_current', 'updated_at']::text[]) THEN
    RETURN NEW;
  END IF;

  IF OLD.validation_status = 'draft'
     AND NEW.validation_status = 'validated'
     AND OLD.validated_at IS NULL
     AND NEW.validated_at IS NOT NULL
     AND NEW.is_current = TRUE
     AND (to_jsonb(OLD) - ARRAY['validation_status', 'validated_at', 'is_current', 'updated_at']::text[])
          IS NOT DISTINCT FROM
         (to_jsonb(NEW) - ARRAY['validation_status', 'validated_at', 'is_current', 'updated_at']::text[]) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'compiled plan content and validation outcome are immutable';
END;
$$ LANGUAGE plpgsql;

-- Intentionally no DB/role/schema/extension/ownership or pgboss.* management.
