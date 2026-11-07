-- Bind reconciliation receipts to the exact lifecycle state observed at apply.
-- The constant default backfills historical rows as part of ALTER TABLE itself,
-- avoiding UPDATE against the receipt ledger's append-only trigger.
ALTER TABLE ssdlc_reconciliation_receipts
  ADD COLUMN IF NOT EXISTS reconciliation_watermarks JSONB NOT NULL DEFAULT jsonb_build_object(
    'compiledPlan', 'sha256:' || repeat('0', 64),
    'evidence', 'sha256:' || repeat('0', 64),
    'decisions', 'sha256:' || repeat('0', 64),
    'runs', 'sha256:' || repeat('0', 64),
    'mutationState', 'sha256:' || repeat('0', 64)
  );

-- New receipts must always supply observed identity; the sentinel is exclusively
-- for artifacts created before watermark binding existed.
ALTER TABLE ssdlc_reconciliation_receipts
  ALTER COLUMN reconciliation_watermarks DROP DEFAULT;

ALTER TABLE ssdlc_reconciliation_receipts
  DROP CONSTRAINT IF EXISTS ssdlc_reconciliation_watermarks_check;
ALTER TABLE ssdlc_reconciliation_receipts
  ADD CONSTRAINT ssdlc_reconciliation_watermarks_check CHECK (
    jsonb_typeof(reconciliation_watermarks) = 'object'
    AND reconciliation_watermarks ?& ARRAY[
      'compiledPlan', 'evidence', 'decisions', 'runs', 'mutationState'
    ]
    AND reconciliation_watermarks - ARRAY[
      'compiledPlan', 'evidence', 'decisions', 'runs', 'mutationState'
    ] = '{}'::jsonb
    AND reconciliation_watermarks->>'compiledPlan' ~ '^sha256:[0-9a-f]{64}$'
    AND reconciliation_watermarks->>'evidence' ~ '^sha256:[0-9a-f]{64}$'
    AND reconciliation_watermarks->>'decisions' ~ '^sha256:[0-9a-f]{64}$'
    AND reconciliation_watermarks->>'runs' ~ '^sha256:[0-9a-f]{64}$'
    AND reconciliation_watermarks->>'mutationState' ~ '^sha256:[0-9a-f]{64}$'
  );
