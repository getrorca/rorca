CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tool_name TEXT NOT NULL,
  token_tier TEXT NOT NULL CHECK (token_tier IN ('public', 'admin')),
  remote_addr TEXT,
  session_id TEXT,
  params_hash TEXT,
  success BOOLEAN NOT NULL,
  error_code TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_ts ON mcp_audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_token_tier ON mcp_audit_log (token_tier, ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_tool ON mcp_audit_log (tool_name, ts DESC);
