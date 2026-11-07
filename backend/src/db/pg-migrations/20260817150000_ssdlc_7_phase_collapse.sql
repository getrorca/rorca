-- 20260817150000_ssdlc_7_phase_collapse.sql
--
-- Brownfield compatibility for the historical eleven-phase SSDLC contract.
-- The migration runner owns the transaction boundary. Historical compiled plans,
-- evidence, and decisions are immutable ledgers: this migration never rewrites or
-- deletes them. Canonical seven-phase identities are exposed through explicit,
-- auditable mappings and projections while the original rows remain authoritative.

CREATE TABLE IF NOT EXISTS rorca.ssdlc_legacy_phase_compatibility (
  source_contract TEXT NOT NULL DEFAULT 'legacy-eleven-v1'
    CHECK (source_contract = 'legacy-eleven-v1'),
  legacy_phase_id TEXT PRIMARY KEY CHECK (btrim(legacy_phase_id) <> ''),
  canonical_phase_id TEXT NOT NULL CHECK (canonical_phase_id IN (
    'planning', 'requirements', 'design', 'development', 'testing',
    'deployment', 'maintenance'
  )),
  legacy_ordinal SMALLINT NOT NULL UNIQUE CHECK (legacy_ordinal BETWEEN 1 AND 11),
  UNIQUE (legacy_phase_id, canonical_phase_id)
);

-- This cutover is deliberately forward-only.
--
-- Existing ssdlc_decisions, ssdlc_lifecycle_decisions, and
-- ssdlc_lifecycle_evidence rows are immutable audit records. Rewriting their
-- phase or gate identifiers would invalidate the authority and provenance they
-- record. Existing ssdlc_compiled_plans are likewise digest- and
-- approval-bound historical artifacts and must not be rewritten in place.
--
-- The application/compiler changes shipped with this migration emit the seven
-- canonical phase identifiers for every newly compiled plan, decision, and
-- evidence row. Historical eleven-phase artifacts retain their original
-- identities; compatibility projection belongs at read time, never in the
-- append-only ledgers.
INSERT INTO rorca.ssdlc_legacy_phase_compatibility
  (legacy_phase_id, canonical_phase_id, legacy_ordinal)
VALUES
  ('intake', 'planning', 1),
  ('requirements', 'requirements', 2),
  ('architecture', 'design', 3),
  ('implementation', 'development', 4),
  ('validation', 'testing', 5),
  ('security', 'testing', 6),
  ('staging', 'deployment', 7),
  ('qa', 'testing', 8),
  ('merge', 'deployment', 9),
  ('production', 'deployment', 10),
  ('learn', 'maintenance', 11)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS rorca.ssdlc_legacy_gate_compatibility (
  source_contract TEXT NOT NULL DEFAULT 'legacy-eleven-v1'
    CHECK (source_contract = 'legacy-eleven-v1'),
  legacy_gate_id TEXT PRIMARY KEY CHECK (btrim(legacy_gate_id) <> ''),
  canonical_gate_id TEXT NOT NULL CHECK (btrim(canonical_gate_id) <> ''),
  legacy_phase_id TEXT NOT NULL,
  canonical_phase_id TEXT NOT NULL CHECK (canonical_phase_id IN (
    'planning', 'requirements', 'design', 'development', 'testing',
    'deployment', 'maintenance'
  )),
  FOREIGN KEY (legacy_phase_id, canonical_phase_id)
    REFERENCES rorca.ssdlc_legacy_phase_compatibility(legacy_phase_id, canonical_phase_id),
  UNIQUE (legacy_gate_id, canonical_gate_id)
);

INSERT INTO rorca.ssdlc_legacy_gate_compatibility
  (legacy_gate_id, canonical_gate_id, legacy_phase_id, canonical_phase_id)
VALUES
  ('gate-ctrl-intake-need-scope', 'gate-ctrl-planning-need-scope', 'intake', 'planning'),
  ('gate-ctrl-intake-risk-classification', 'gate-ctrl-planning-risk-classification', 'intake', 'planning'),
  ('gate-ctrl-req-complete-verifiable', 'gate-ctrl-requirements-complete-verifiable', 'requirements', 'requirements'),
  ('gate-ctrl-req-traceability', 'gate-ctrl-requirements-traceability', 'requirements', 'requirements'),
  ('gate-ctrl-arch-decisions-quality', 'gate-ctrl-design-decisions-quality', 'architecture', 'design'),
  ('gate-ctrl-arch-threat-boundaries', 'gate-ctrl-design-threat-boundaries', 'architecture', 'design'),
  ('gate-ctrl-impl-secure-review', 'gate-ctrl-development-secure-review', 'implementation', 'development'),
  ('gate-ctrl-impl-trace-unit', 'gate-ctrl-development-trace-unit', 'implementation', 'development'),
  ('gate-ctrl-val-req-regression', 'gate-ctrl-testing-req-regression', 'validation', 'testing'),
  ('gate-ctrl-val-quality-attributes', 'gate-ctrl-testing-quality-attributes', 'validation', 'testing'),
  ('gate-ctrl-sec-threat-authz-secrets', 'gate-ctrl-testing-threat-authz-secrets', 'security', 'testing'),
  ('gate-ctrl-sec-supply-chain', 'gate-ctrl-testing-supply-chain', 'security', 'testing'),
  ('gate-ctrl-stage-readiness-parity', 'gate-ctrl-deployment-readiness-parity', 'staging', 'deployment'),
  ('gate-ctrl-stage-release-evidence', 'gate-ctrl-deployment-release-evidence', 'staging', 'deployment'),
  ('gate-ctrl-qa-acceptance', 'gate-ctrl-testing-acceptance', 'qa', 'testing'),
  ('gate-ctrl-qa-independent-review', 'gate-ctrl-testing-independent-review', 'qa', 'testing'),
  ('gate-ctrl-merge-approval-integration', 'gate-ctrl-deployment-approval-integration', 'merge', 'deployment'),
  ('gate-ctrl-merge-evidence-complete', 'gate-ctrl-deployment-evidence-complete', 'merge', 'deployment'),
  ('gate-ctrl-prod-approval-deployment', 'gate-ctrl-deployment-approval-deployment', 'production', 'deployment'),
  ('gate-ctrl-prod-rollback-observe', 'gate-ctrl-deployment-rollback-observe', 'production', 'deployment'),
  ('gate-ctrl-learn-outcome-metrics', 'gate-ctrl-maintenance-outcome-metrics', 'learn', 'maintenance'),
  ('gate-ctrl-learn-incident-controls', 'gate-ctrl-maintenance-incident-controls', 'learn', 'maintenance')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS rorca.ssdlc_legacy_evidence_requirement_compatibility (
  source_contract TEXT NOT NULL DEFAULT 'legacy-eleven-v1'
    CHECK (source_contract = 'legacy-eleven-v1'),
  legacy_evidence_requirement_id TEXT PRIMARY KEY CHECK (btrim(legacy_evidence_requirement_id) <> ''),
  canonical_evidence_requirement_id TEXT NOT NULL CHECK (btrim(canonical_evidence_requirement_id) <> ''),
  legacy_gate_id TEXT NOT NULL,
  canonical_gate_id TEXT NOT NULL CHECK (btrim(canonical_gate_id) <> ''),
  FOREIGN KEY (legacy_gate_id, canonical_gate_id)
    REFERENCES rorca.ssdlc_legacy_gate_compatibility(legacy_gate_id, canonical_gate_id),
  UNIQUE (legacy_evidence_requirement_id, canonical_evidence_requirement_id)
);

INSERT INTO rorca.ssdlc_legacy_evidence_requirement_compatibility
  (legacy_evidence_requirement_id, canonical_evidence_requirement_id, legacy_gate_id, canonical_gate_id)
SELECT
  'evidence-' || substring(legacy_gate_id FROM 6) || '-1',
  'evidence-' || substring(canonical_gate_id FROM 6) || '-1',
  legacy_gate_id,
  canonical_gate_id
FROM rorca.ssdlc_legacy_gate_compatibility
ON CONFLICT DO NOTHING;

-- Preserve every historical requirement ordinal found in compiled plans. The
-- static rows above cover the minimum contract; this projection records -2,
-- -3, and later requirement IDs without changing the source plan bytes.
INSERT INTO rorca.ssdlc_legacy_evidence_requirement_compatibility
  (legacy_evidence_requirement_id, canonical_evidence_requirement_id, legacy_gate_id, canonical_gate_id)
SELECT
  requirement.value->>'evidenceRequirementId',
  'evidence-' || substring(gate_map.canonical_gate_id FROM 6)
    || substring(
      requirement.value->>'evidenceRequirementId'
      FROM char_length('evidence-' || substring(gate_map.legacy_gate_id FROM 6)) + 1
    ),
  gate_map.legacy_gate_id,
  gate_map.canonical_gate_id
FROM rorca.ssdlc_compiled_plans AS plan
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(plan.plan_json->'evidenceRequirements') = 'array'
    THEN plan.plan_json->'evidenceRequirements' ELSE '[]'::jsonb END
) AS requirement(value)
JOIN rorca.ssdlc_legacy_gate_compatibility AS gate_map
  ON gate_map.legacy_gate_id = requirement.value->>'gateId'
WHERE requirement.value->>'evidenceRequirementId'
  LIKE 'evidence-' || substring(gate_map.legacy_gate_id FROM 6) || '-%'
ON CONFLICT DO NOTHING;

-- A historical evidence row may name an ordinal omitted from its stored plan.
-- Record those IDs too while leaving the append-only evidence fact untouched.
INSERT INTO rorca.ssdlc_legacy_evidence_requirement_compatibility
  (legacy_evidence_requirement_id, canonical_evidence_requirement_id, legacy_gate_id, canonical_gate_id)
SELECT
  requirement.legacy_requirement_id,
  'evidence-' || substring(gate_map.canonical_gate_id FROM 6)
    || substring(
      requirement.legacy_requirement_id
      FROM char_length('evidence-' || substring(gate_map.legacy_gate_id FROM 6)) + 1
    ),
  gate_map.legacy_gate_id,
  gate_map.canonical_gate_id
FROM rorca.ssdlc_lifecycle_evidence AS evidence
JOIN rorca.ssdlc_legacy_gate_compatibility AS gate_map
  ON gate_map.legacy_gate_id = evidence.gate_id
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(evidence.metadata->'evidenceRequirementIds') = 'array'
    THEN evidence.metadata->'evidenceRequirementIds' ELSE '[]'::jsonb END
) AS requirement(legacy_requirement_id)
WHERE requirement.legacy_requirement_id
  LIKE 'evidence-' || substring(gate_map.legacy_gate_id FROM 6) || '-%'
ON CONFLICT DO NOTHING;

-- Existing projection-kind values remain auditable; all new writers use the
-- canonical phase identities. The expanded check is a metadata contract change
-- only and does not touch append-only evidence rows.
ALTER TABLE rorca.ssdlc_lifecycle_evidence
  DROP CONSTRAINT IF EXISTS ssdlc_lifecycle_evidence_delivery_projection_kind_check;
ALTER TABLE rorca.ssdlc_lifecycle_evidence
  ADD CONSTRAINT ssdlc_lifecycle_evidence_delivery_projection_kind_check
  CHECK (delivery_projection_kind IS NULL OR delivery_projection_kind IN (
    'validation', 'merge', 'testing', 'deployment'
  ));

-- Compatibility relations deliberately return both stored and canonical IDs.
-- Consumers can query historical facts without confusing the projection with
-- the byte-preserved ledger authority.
CREATE OR REPLACE VIEW rorca.ssdlc_lifecycle_evidence_compatibility AS
SELECT
  evidence.*,
  COALESCE(phase_map.canonical_phase_id, evidence.phase_id) AS canonical_phase_id,
  COALESCE(gate_map.canonical_gate_id, evidence.gate_id) AS canonical_gate_id,
  CASE evidence.delivery_projection_kind
    WHEN 'validation' THEN 'testing'
    WHEN 'merge' THEN 'deployment'
    ELSE evidence.delivery_projection_kind
  END AS canonical_delivery_projection_kind,
  CASE
    WHEN phase_map.legacy_phase_id IS NOT NULL OR gate_map.legacy_gate_id IS NOT NULL
      OR evidence.delivery_projection_kind IN ('validation', 'merge')
      THEN 'legacy-eleven-v1'
    ELSE 'canonical-seven-v1'
  END AS lifecycle_contract
FROM rorca.ssdlc_lifecycle_evidence AS evidence
LEFT JOIN rorca.ssdlc_legacy_phase_compatibility AS phase_map
  ON phase_map.legacy_phase_id = evidence.phase_id
LEFT JOIN rorca.ssdlc_legacy_gate_compatibility AS gate_map
  ON gate_map.legacy_gate_id = evidence.gate_id;

CREATE OR REPLACE VIEW rorca.ssdlc_lifecycle_decisions_compatibility AS
SELECT
  decision.*,
  COALESCE(phase_map.canonical_phase_id, decision.phase_id) AS canonical_phase_id,
  COALESCE(gate_map.canonical_gate_id, decision.gate_id) AS canonical_gate_id,
  CASE
    WHEN phase_map.legacy_phase_id IS NOT NULL OR gate_map.legacy_gate_id IS NOT NULL
      THEN 'legacy-eleven-v1'
    ELSE 'canonical-seven-v1'
  END AS lifecycle_contract
FROM rorca.ssdlc_lifecycle_decisions AS decision
LEFT JOIN rorca.ssdlc_legacy_phase_compatibility AS phase_map
  ON phase_map.legacy_phase_id = decision.phase_id
LEFT JOIN rorca.ssdlc_legacy_gate_compatibility AS gate_map
  ON gate_map.legacy_gate_id = decision.gate_id;

CREATE OR REPLACE VIEW rorca.ssdlc_decisions_compatibility AS
SELECT
  decision.*,
  COALESCE(phase_map.canonical_phase_id, decision.phase_id) AS canonical_phase_id,
  COALESCE(gate_map.canonical_gate_id, decision.gate_id) AS canonical_gate_id,
  CASE
    WHEN phase_map.legacy_phase_id IS NOT NULL OR gate_map.legacy_gate_id IS NOT NULL
      THEN 'legacy-eleven-v1'
    ELSE 'canonical-seven-v1'
  END AS lifecycle_contract
FROM rorca.ssdlc_decisions AS decision
LEFT JOIN rorca.ssdlc_legacy_phase_compatibility AS phase_map
  ON phase_map.legacy_phase_id = decision.phase_id
LEFT JOIN rorca.ssdlc_legacy_gate_compatibility AS gate_map
  ON gate_map.legacy_gate_id = decision.gate_id;

CREATE OR REPLACE VIEW rorca.ssdlc_compiled_plan_compatibility AS
SELECT
  plan.*,
  CASE WHEN plan.plan_json->'phaseOrder' ? 'intake'
    THEN 'legacy-eleven-v1'
    ELSE 'canonical-seven-v1'
  END AS lifecycle_contract,
  (
    SELECT jsonb_object_agg(mapping.legacy_phase_id, mapping.canonical_phase_id
      ORDER BY mapping.legacy_ordinal)
    FROM rorca.ssdlc_legacy_phase_compatibility AS mapping
  ) AS canonical_phase_projection
FROM rorca.ssdlc_compiled_plans AS plan;

-- The compatibility contract itself is immutable after installation. Replaying
-- this migration is safe because inserts above are conflict-free no-ops.
CREATE OR REPLACE FUNCTION rorca.guard_ssdlc_legacy_compatibility_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'SSDLC historical compatibility mappings are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ssdlc_legacy_phase_compatibility_immutable
  ON rorca.ssdlc_legacy_phase_compatibility;
CREATE TRIGGER ssdlc_legacy_phase_compatibility_immutable
  BEFORE UPDATE OR DELETE ON rorca.ssdlc_legacy_phase_compatibility
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_ssdlc_legacy_compatibility_mutation();

DROP TRIGGER IF EXISTS ssdlc_legacy_gate_compatibility_immutable
  ON rorca.ssdlc_legacy_gate_compatibility;
CREATE TRIGGER ssdlc_legacy_gate_compatibility_immutable
  BEFORE UPDATE OR DELETE ON rorca.ssdlc_legacy_gate_compatibility
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_ssdlc_legacy_compatibility_mutation();

DROP TRIGGER IF EXISTS ssdlc_legacy_evidence_requirement_compatibility_immutable
  ON rorca.ssdlc_legacy_evidence_requirement_compatibility;
CREATE TRIGGER ssdlc_legacy_evidence_requirement_compatibility_immutable
  BEFORE UPDATE OR DELETE ON rorca.ssdlc_legacy_evidence_requirement_compatibility
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_ssdlc_legacy_compatibility_mutation();
