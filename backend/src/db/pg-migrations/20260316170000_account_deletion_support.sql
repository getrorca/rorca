-- 20260316170000_account_deletion_support.sql
-- Add triggered_by to pipeline_runs for user anonymization on account deletion.
-- Change story_comments.user_id FK from CASCADE to SET NULL for anonymization.

-- Add triggered_by column (nullable TEXT, no FK — stores 'deleted_user' after deletion)
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS triggered_by TEXT;

-- Drop the existing CASCADE FK on story_comments.user_id and recreate as SET NULL
-- so account deletion anonymizes comments instead of deleting them.
DO $$
BEGIN
  -- Drop existing FK if it exists (named or unnamed)
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'story_comments'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name IN (
        SELECT constraint_name FROM information_schema.key_column_usage
        WHERE table_name = 'story_comments' AND column_name = 'user_id'
      )
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE story_comments DROP CONSTRAINT ' || constraint_name
      FROM information_schema.key_column_usage
      WHERE table_name = 'story_comments' AND column_name = 'user_id'
      LIMIT 1
    );
  END IF;
END $$;

ALTER TABLE story_comments
  ADD CONSTRAINT fk_story_comments_user_id
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
