-- CCS-015 hardening: align brownfield memory_candidates constraints with the
-- sidecar contract. Some local databases may already have memory_candidates
-- from earlier context/memory prototypes with narrower trust-tier or category
-- checks. Reconcile before live sidecar writes.

DO $$
BEGIN
  IF to_regclass('memory_candidates') IS NOT NULL THEN
    UPDATE memory_candidates
       SET trust_tier = 'agent_observation'
     WHERE trust_tier IS NULL
        OR trust_tier NOT IN (
          'agent_observation',
          'working_note',
          'engineering_decision',
          'approved_policy',
          'verified_fact'
        );

    UPDATE memory_candidates
       SET suggested_category = COALESCE(NULLIF(btrim(suggested_category), ''), 'Decision')
     WHERE suggested_category IS NULL
        OR suggested_category NOT IN ('Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha');

    UPDATE memory_candidates
       SET confidence = 'low'
     WHERE confidence IS NULL
        OR confidence NOT IN ('high', 'medium', 'low');

    UPDATE memory_candidates
       SET review_status = 'pending'
     WHERE review_status IS NULL
        OR review_status NOT IN ('pending', 'approved', 'rejected', 'superseded', 'duplicate', 'conflict', 'deferred');

    ALTER TABLE memory_candidates DROP CONSTRAINT IF EXISTS memory_candidates_trust_tier_check;
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_trust_tier_check
      CHECK (trust_tier IN (
        'agent_observation',
        'working_note',
        'engineering_decision',
        'approved_policy',
        'verified_fact'
      ));

    ALTER TABLE memory_candidates DROP CONSTRAINT IF EXISTS memory_candidates_category_check;
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_category_check
      CHECK (suggested_category IN ('Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha'));

    ALTER TABLE memory_candidates DROP CONSTRAINT IF EXISTS memory_candidates_confidence_check;
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_confidence_check
      CHECK (confidence IN ('high', 'medium', 'low'));

    ALTER TABLE memory_candidates DROP CONSTRAINT IF EXISTS memory_candidates_review_status_check;
    ALTER TABLE memory_candidates
      ADD CONSTRAINT memory_candidates_review_status_check
      CHECK (review_status IN ('pending', 'approved', 'rejected', 'superseded', 'duplicate', 'conflict', 'deferred'));
  END IF;

  IF to_regclass('context_events') IS NOT NULL THEN
    UPDATE context_events
       SET trust_tier = 'agent_observation'
     WHERE trust_tier IS NULL
        OR trust_tier NOT IN (
          'agent_observation',
          'working_note',
          'engineering_decision',
          'approved_policy',
          'verified_fact'
        );

    ALTER TABLE context_events DROP CONSTRAINT IF EXISTS context_events_trust_tier_check;
    ALTER TABLE context_events
      ADD CONSTRAINT context_events_trust_tier_check
      CHECK (trust_tier IN (
        'agent_observation',
        'working_note',
        'engineering_decision',
        'approved_policy',
        'verified_fact'
      ));
  END IF;
END $$;
