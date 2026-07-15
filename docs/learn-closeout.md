# Governed Learn-phase closeout

The Learn producer runs after a pipeline run reaches a terminal state and release routing has persisted its final outcome. It does **not** make or revise the delivery outcome.

## Authority boundary

Eligible facts come from:

- accepted `story_closeout_decisions` backed by host validation;
- normalized SSDLC evidence whose trust is `host_observed`, `provider_verified`, or `authenticated_manual`;
- active governed lifecycle decisions and approvals;
- persisted retry-preview reason codes and retry lineage; and
- persisted run, merge, PR, commit, artifact, and deployment outcomes.

Agent completion-packet prose, raw logs, terminal output, and advisory session memory are not queried by this producer.

## Candidate lifecycle

`backend/src/lib/learn-closeout.ts` deterministically creates a maximum of 24 candidates and stages them in the existing `memory_candidates` queue. Categories cover decisions, patterns, bug fixes, gotchas, and follow-ups. Every candidate starts `review_required` and `default_retrieval_eligible=false`; sensitive production, security, credential, destructive-migration, and private-communication facts cannot be auto-approved.

The existing review operations apply: approve, reject, revisit, and archive. Approval creates a provenance-linked `memories` row. Review writes commit first, then emit audited `lifecycle_changed` WAL/SSE invalidation scoped to the affected spec's Learn phase.

## Redaction and optional summarization

Strict capture plus Learn-specific redaction removes credentials, tokens, private Slack references, customer/tenant identifiers, unsafe raw content, and canaries before persistence and before any model call. Optional summarization receives only the redacted deterministic fact. A summary is accepted only when every normalized output token is supported by the deterministic fact; otherwise the deterministic candidate is retained. Provider failure returns a typed retryable summarization blocker and does not alter the completed run.

## Dedupe and phase state

The dedupe key is the hash of workspace, normalized fact, and release subject. Run and attempt IDs are intentionally excluded, so equivalent retries reuse a candidate while a changed release subject or outcome remains separately reviewable.

`pipeline_runs.learn_closeout_*` stores only bounded producer status and candidate IDs; it is not a second memory system. The Learn read model remains `not_started` when no candidate exists and `blocked` when generation fails. It exposes required/actual candidate and evidence counts, review states, provenance, blocker, and next action. A normalized `memory_closeout` evidence record is written only after at least one reviewable candidate is durable.
