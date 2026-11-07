# HackBot MVP Requirements

This is the canonical, finite requirement baseline for the governed bug-bounty mission-control MVP. Normative keywords follow RFC 2119.

| ID | Priority | Requirement |
|---|---|---|
| HB-AUTH-001 | MUST | The Controller is the only mission-state mutation authority. |
| HB-EFFECT-001 | MUST | All target effects pass through the effect broker; no other component may directly cause a target effect. |
| HB-WORKER-001 | MUST | Workers are untrusted proposers and cannot mutate mission state or execute effects directly. |
| HB-HERMES-001 | MUST | Hermes only relays authenticated envelopes and cannot authorize mutations or effects. |
| HB-SCOPE-001 | MUST | Controller-issued, epoch-bound scope is checked before each effect. |
| HB-EPOCH-001 | MUST | Stale epochs and replayed effect requests fail closed. |
| HB-EFFECT-002 | MUST | Unknown effect kinds fail closed. |
| HB-EVIDENCE-001 | MUST | Evidence is content-addressed, append-only and linked to the authorizing effect receipt. |
| HB-NET-001 | MUST | Release workers run on Linux in a bwrap sandbox with broker-only network and process mediation. |
| HB-DNS-001 | MUST | The broker validates DNS answers and every redirect hop against scope. |
| HB-SECRETS-001 | MUST | Credentials are broker-held, least-privilege and redacted from worker prompts, logs and evidence. |
| HB-SUBMIT-001 | MUST | Finding submission remains an explicit authenticated human action. |
| HB-AUDIT-001 | MUST | Authority decisions, proposals, effects, receipts and evidence transitions are tamper-evident and attributable. |
| HB-HUMAN-001 | MUST | A human operator controls program enrollment, credentials, scope approval, destructive-action exceptions and submission. |
| HB-RELEASE-001 | MUST | MVP runs one hunter per mission and excludes autonomous accounts, CAPTCHA bypass, protocol fuzzing and destructive actions. |
| HB-UI-001 | SHOULD | Mission control displays scope, epoch, proposals, effects, evidence and human approvals. |
