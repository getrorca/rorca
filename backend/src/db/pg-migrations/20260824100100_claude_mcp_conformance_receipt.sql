-- 20260824100000_claude_mcp_conformance_receipt.sql
-- BSB-004 adds one append-only, redacted execution receipt after the complete
-- real-Claude fixture journey. OAuth grants and browser session state continue
-- to live in their existing bounded stores; no token or cookie is persisted.

ALTER TABLE rorca.authority_provider_receipts
  DROP CONSTRAINT authority_provider_receipts_event_type_check;
ALTER TABLE rorca.authority_provider_receipts
  ADD CONSTRAINT authority_provider_receipts_event_type_check CHECK (event_type IN (
    'enrollment_started', 'enrollment_completed', 'profile_use_denied',
    'profile_quarantined', 'profile_deleted',
    'browser_lease_requested', 'browser_lease_issued', 'browser_security_denied',
    'browser_lease_revoked', 'browser_lease_uncertain', 'browser_lease_reconciled',
    'browser_authentication_requested', 'browser_authentication_revalidating',
    'browser_authentication_resumed', 'browser_authentication_terminal',
    'claude_mcp_conformance_completed'
  ));

COMMENT ON TABLE rorca.authority_provider_receipts IS
  'Append-only redacted browser authority and conformance evidence. BSB-004 stores one complete Claude execution receipt with opaque artifact IDs and hashes, never cookies or OAuth tokens.';
