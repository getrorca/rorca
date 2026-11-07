-- BBM-024: Program-scoped reflection and exact-review generalized lessons.
-- Raw bounty observations never enter generic memory or cross a program boundary.

-- Composite authority keys let every raw row prove its mission belongs to the
-- same program instead of relying only on application checks.
ALTER TABLE bounty_missions ADD CONSTRAINT bounty_missions_program_identity
  UNIQUE (workspace_id, program_id, id);

CREATE TABLE bounty_program_reflections (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  source_mission_id UUID NOT NULL,
  reflection_kind TEXT NOT NULL CHECK (reflection_kind IN ('false-positive','rejection','duplicate','dead-gadget','disclosure')),
  subject_fingerprint TEXT NOT NULL CHECK (subject_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  observation_bytes BYTEA NOT NULL CHECK (octet_length(observation_bytes) BETWEEN 1 AND 1000000),
  observation_hash TEXT NOT NULL CHECK (observation_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^REFLECTION_[A-Z_]+$'),
  recorded_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, program_id, reflection_kind, subject_fingerprint),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, program_id, source_mission_id) REFERENCES bounty_missions(workspace_id, program_id, id)
);
CREATE INDEX bounty_program_reflections_check_idx
  ON bounty_program_reflections(workspace_id, program_id, subject_fingerprint);

CREATE TABLE bounty_reflection_checks (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  mission_id UUID NOT NULL,
  boundary TEXT NOT NULL CHECK (boundary IN ('route','candidate-admission')),
  subject_hash TEXT NOT NULL CHECK (subject_hash ~ '^sha256:[0-9a-f]{64}$'),
  checked_fingerprints TEXT[] NOT NULL CHECK (cardinality(checked_fingerprints) > 0),
  matched_reflection_ids UUID[] NOT NULL DEFAULT '{}',
  decision TEXT NOT NULL CHECK (decision IN ('allow','block')),
  reason_codes TEXT[] NOT NULL CHECK (cardinality(reason_codes) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, program_id, mission_id) REFERENCES bounty_missions(workspace_id, program_id, id)
);
CREATE INDEX bounty_reflection_checks_mission_idx
  ON bounty_reflection_checks(workspace_id, mission_id, created_at DESC);

CREATE TABLE bounty_mission_closeouts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  mission_id UUID NOT NULL,
  closeout_bytes BYTEA NOT NULL CHECK (octet_length(closeout_bytes) BETWEEN 1 AND 1000000),
  closeout_hash TEXT NOT NULL CHECK (closeout_hash ~ '^sha256:[0-9a-f]{64}$'),
  closed_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, mission_id, closeout_hash),
  UNIQUE (workspace_id, program_id, mission_id, id),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, program_id, mission_id) REFERENCES bounty_missions(workspace_id, program_id, id)
);

CREATE TABLE bounty_lesson_candidate_lineages (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  source_mission_id UUID NOT NULL,
  source_closeout_id UUID NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, program_id, id),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, program_id, source_mission_id) REFERENCES bounty_missions(workspace_id, program_id, id),
  FOREIGN KEY (workspace_id, program_id, source_mission_id, source_closeout_id)
    REFERENCES bounty_mission_closeouts(workspace_id, program_id, mission_id, id)
);

CREATE TABLE bounty_lesson_candidate_revisions (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  lineage_id UUID NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  candidate_bytes BYTEA NOT NULL CHECK (octet_length(candidate_bytes) BETWEEN 1 AND 100000),
  candidate_hash TEXT NOT NULL CHECK (candidate_hash ~ '^sha256:[0-9a-f]{64}$'),
  redaction_manifest JSONB NOT NULL CHECK (
    jsonb_typeof(redaction_manifest) = 'object'
    AND redaction_manifest->>'policyVersion' = 'bounty.lesson-sanitization.v1'
    AND jsonb_typeof(redaction_manifest->'defaultExclusions') = 'array'
    AND jsonb_array_length(redaction_manifest->'defaultExclusions') = 4
    AND jsonb_typeof(redaction_manifest->'redactions') = 'array'
  ),
  redaction_manifest_hash TEXT NOT NULL CHECK (redaction_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  edit_reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, lineage_id, revision),
  UNIQUE (workspace_id, program_id, candidate_hash),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, program_id, lineage_id) REFERENCES bounty_lesson_candidate_lineages(workspace_id, program_id, id)
);
CREATE TRIGGER bounty_lesson_candidate_revision_sequence BEFORE INSERT ON bounty_lesson_candidate_revisions
FOR EACH ROW EXECUTE FUNCTION bounty_require_next_number('lineage_id','revision');

CREATE TABLE bounty_lesson_candidate_reviews (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  candidate_revision_id UUID NOT NULL,
  candidate_hash TEXT NOT NULL CHECK (candidate_hash ~ '^sha256:[0-9a-f]{64}$'),
  redaction_manifest_hash TEXT NOT NULL CHECK (redaction_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_closeout_hash TEXT NOT NULL CHECK (source_closeout_hash ~ '^sha256:[0-9a-f]{64}$'),
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  review_reason TEXT NOT NULL,
  exact_review_hash TEXT NOT NULL CHECK (exact_review_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, candidate_revision_id),
  FOREIGN KEY (workspace_id, candidate_revision_id) REFERENCES bounty_lesson_candidate_revisions(workspace_id, id)
);

CREATE TABLE bounty_generalized_lessons (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_program_id UUID NOT NULL,
  source_mission_id UUID NOT NULL,
  candidate_revision_id UUID NOT NULL,
  lesson_bytes BYTEA NOT NULL CHECK (octet_length(lesson_bytes) BETWEEN 1 AND 100000),
  lesson_hash TEXT NOT NULL CHECK (lesson_hash ~ '^sha256:[0-9a-f]{64}$'),
  exact_review_hash TEXT NOT NULL CHECK (exact_review_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, candidate_revision_id),
  UNIQUE (workspace_id, lesson_hash),
  FOREIGN KEY (workspace_id, source_program_id) REFERENCES bounty_programs(workspace_id, id),
  FOREIGN KEY (workspace_id, source_mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, candidate_revision_id) REFERENCES bounty_lesson_candidate_revisions(workspace_id, id)
);

CREATE TABLE bounty_mission_lesson_pins (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  lesson_id UUID NOT NULL,
  lesson_hash TEXT NOT NULL CHECK (lesson_hash ~ '^sha256:[0-9a-f]{64}$'),
  pinned_by TEXT NOT NULL,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, mission_id, lesson_hash),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, lesson_id) REFERENCES bounty_generalized_lessons(workspace_id, id)
);

-- Database defense in depth: no same-mission hot loading and no retrospective pins.
CREATE FUNCTION bounty_validate_lesson_pin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_mission UUID; source_created TIMESTAMPTZ; target_created TIMESTAMPTZ; target_state TEXT; actual_hash TEXT;
BEGIN
  SELECT source_mission_id,lesson_hash INTO source_mission,actual_hash
    FROM bounty_generalized_lessons WHERE workspace_id=NEW.workspace_id AND id=NEW.lesson_id FOR SHARE;
  SELECT created_at INTO source_created FROM bounty_missions WHERE workspace_id=NEW.workspace_id AND id=source_mission;
  SELECT created_at,state INTO target_created,target_state FROM bounty_missions WHERE workspace_id=NEW.workspace_id AND id=NEW.mission_id FOR SHARE;
  IF source_mission = NEW.mission_id OR target_created <= source_created OR target_state <> 'draft' THEN
    RAISE EXCEPTION 'lesson can only be pinned by a later draft mission' USING ERRCODE = '42501';
  END IF;
  IF actual_hash IS NULL OR actual_hash <> NEW.lesson_hash THEN
    RAISE EXCEPTION 'lesson pin hash mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_mission_lesson_pin_guard BEFORE INSERT ON bounty_mission_lesson_pins
FOR EACH ROW EXECUTE FUNCTION bounty_validate_lesson_pin();

-- Candidate rows are deliberately absent from every retrieval relation. Only an
-- exact approved review creates a generalized lesson, and retrieval joins pins.
CREATE VIEW bounty_pinned_generalized_lessons AS
SELECT p.workspace_id,p.mission_id,p.lesson_hash,l.lesson_bytes,l.source_program_id,l.source_mission_id,l.exact_review_hash
FROM bounty_mission_lesson_pins p
JOIN bounty_generalized_lessons l ON l.workspace_id=p.workspace_id AND l.id=p.lesson_id AND l.lesson_hash=p.lesson_hash;

CREATE TRIGGER bounty_program_reflections_immutable BEFORE UPDATE OR DELETE ON bounty_program_reflections
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_reflection_checks_immutable BEFORE UPDATE OR DELETE ON bounty_reflection_checks
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_mission_closeouts_immutable BEFORE UPDATE OR DELETE ON bounty_mission_closeouts
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_lesson_candidate_lineages_immutable BEFORE UPDATE OR DELETE ON bounty_lesson_candidate_lineages
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_lesson_candidate_revisions_immutable BEFORE UPDATE OR DELETE ON bounty_lesson_candidate_revisions
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_lesson_candidate_reviews_immutable BEFORE UPDATE OR DELETE ON bounty_lesson_candidate_reviews
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_generalized_lessons_immutable BEFORE UPDATE OR DELETE ON bounty_generalized_lessons
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
CREATE TRIGGER bounty_mission_lesson_pins_immutable BEFORE UPDATE OR DELETE ON bounty_mission_lesson_pins
FOR EACH ROW EXECUTE FUNCTION bounty_reject_append_only_mutation();
