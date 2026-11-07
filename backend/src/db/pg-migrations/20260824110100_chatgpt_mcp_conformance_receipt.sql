-- 20260824110000_chatgpt_mcp_conformance_receipt.sql
-- BSB-005 adds one append-only, redacted ChatGPT execution receipt beside the
-- Claude receipt. Browser profiles, cookies, and OAuth values remain outside
-- authority rows; only bounded evidence, digests, and revocation proof persist.

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
    'claude_mcp_conformance_completed', 'chatgpt_mcp_conformance_completed'
  ));

COMMENT ON TABLE rorca.authority_provider_receipts IS
  'Append-only redacted browser authority and consumer-conformance evidence. BSB-004/005 receipts retain opaque artifact IDs, provider-bound isolation digests, and revocation proof, never profiles, cookies, credentials, or OAuth values.';
