# Campaign dispatch authority (minimal Hermes prerequisite)

This contract is intentionally narrower than ROR-23. It adds the last-hop Rorca authority needed by the governed Hermes campaign supervisor without adding a general campaign scheduler.

## Dispatch boundary

An ordinary `POST /api/pipeline/trigger` may include strict `hermes.campaign-dispatch-authorization.v1`. Campaign-bearing requests:

- require an authenticated Hermes service request (the exact MCP bearer is accepted only on the campaign trigger and required read projections);
- must select exactly one story, a host-created worktree, sequential execution, `branch-only`, no auto-merge, no external delivery, and no readiness override;
- must match the canonical Hermes/Rorca request hash and authorization hash;
- must be consumed within 120 seconds of issue and before arm/wave expiry.

Immediately before application-outbox publication, Rorca uses one `SERIALIZABLE` transaction to lock and revalidate:

1. the Rorca campaign pause generation;
2. the exact active, unexpired, non-revoked arm decision and artifact subject;
3. the exact active, unexpired, non-revoked wave decision and commit subject;
4. the current GitHub App workspace/repository binding;
5. the canonical queued run and its request/effective options;
6. the one frozen story execution manifest, including actual base revision, agent, run, attempt, spec/story revisions, and branch-only policy;
7. the application-owned dispatch outbox lease and immutable payload.

The same transaction inserts the single-consumption authorization row, binds it to the run, stores a credential-free audit snapshot, and prepares the immutable outbox payload. pg-boss is transport only and is called after commit. Exact HTTP replay returns the existing authorization/run identity; changed or second consumption fails closed.

The Linear and local Git envelopes originate outside Rorca. Rorca validates their complete authenticated hash, bounded shape, accepted state, trusted hosts, issue uniqueness, freshness, and consistency. It independently revalidates the Rorca-owned repository binding, workspace HEAD/remote, and frozen execution base. Rorca does not claim to be the Linear provider; Hermes performs the final Linear read before issuing the short-lived envelope.

## Pause semantics

Human operators can commit a new pause or resume generation through:

- `POST /api/pipeline/campaigns/:campaignId/pause`
- `POST /api/pipeline/campaigns/:campaignId/resume`

Both require an idempotency key, a concrete rationale, and authenticated human platform-admin identity. Service/MCP principals cannot operate these endpoints. Pause and consumption use the same campaign advisory/row lock, so exactly one wins. A pause committed before consumption blocks it; a consumption committed first is immutable authority for that already accepted run.

## Read projections

`GET /api/pipeline/runs/:runId?includeExecutionManifests=true&includeCloseoutDecisions=true` returns:

- integrity-verified stored `executionManifests[]`;
- each story's integrity-verified `attempt_result` and `closeout_decision`;
- an immutable `evidence_snapshot_id`;
- provider-neutral `completion_validation` based on host provenance, accepted closeout, and active commit;
- the immutable consumed `campaignAuthorization` projection when applicable.

Completion validation is agent-neutral (`claude`, `opencode`, `codex`, or `pi`) and never requires a Pi-only packet. Exact authorization schemas, version constants, parser, canonical hash helper, and projection types are exported from `packages/rorca-public-contract`.

## Secret handling

The durable campaign snapshot excludes Git remote URLs, filesystem roots, credentials, and raw provider payloads. Audit events contain only canonical hashes/IDs, policy identities, repository/base identity, and pause generation. Credential-bearing Git or Linear URLs are rejected at the boundary.
