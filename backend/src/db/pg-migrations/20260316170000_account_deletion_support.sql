-- 20260316170000_account_deletion_support.sql
-- Add triggered_by to pipeline_runs for user anonymization on account deletion.
-- Change story_comments.user_id FK from CASCADE to SET NULL for anonymization.

-- Add triggered_by column (nullable TEXT, no FK — stores 'deleted_user' after deletion)
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS triggered_by TEXT;

-- Drop the existing FK on story_comments.user_id and recreate as SET NULL
-- so account deletion anonymizes comments instead of deleting them.
DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT tc.constraint_name
    INTO v_constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
     AND tc.table_name = kcu.table_name
   WHERE tc.table_schema = 'rorca'
     AND tc.table_name = 'story_comments'
     AND tc.constraint_type = 'FOREIGN KEY'
     AND kcu.column_name = 'user_id'
   LIMIT 1;

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE story_comments DROP CONSTRAINT IF EXISTS %I', v_constraint_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'rorca'
      AND table_name = 'story_comments'
      AND constraint_name = 'fk_story_comments_user_id'
  ) THEN
    ALTER TABLE story_comments
      ADD CONSTRAINT fk_story_comments_user_id
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
