-- 061_spec_attachments.sql — File attachments associated with specs (images, PDFs, etc.)

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attachment_storage_type') THEN
    CREATE TYPE attachment_storage_type AS ENUM ('database', 's3');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS spec_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  storage_type attachment_storage_type NOT NULL DEFAULT 'database',
  file_data BYTEA,
  s3_key TEXT,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spec_attachments_spec_id ON spec_attachments(spec_id);
