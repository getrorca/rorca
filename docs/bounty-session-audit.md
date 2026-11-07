# Governed bounty session audit

BBM-022 adds the operator-facing audit boundary for bounty missions.

## Authoritative stream and reconnect

`bounty_authoritative_session_events` is the immutable, redacted record emitted by worker, validator, reporter, and broker roles. An append transaction allocates one monotonically increasing cursor per mission and deduplicates on `eventIdentity` plus a hash of the original source event.

Consumers call:

```text
GET /api/admin/bounty/sessions/:missionId/events?workspaceId=...&after=<cursor>&limit=200
```

`after` is exclusive. Process events in ascending order and persist the returned `nextCursor` only after processing the page. Reusing that cursor cannot duplicate an event; committed events cannot be skipped. `hasMore` indicates another immediate page.

Activity and alert tables are rebuildable projections that reference a source cursor. They are deliberately separate from authoritative session events and must never replace them as audit evidence.

## Governed intervention

A nudge is advisory text bound immutably to:

- credential-authenticated operator identity;
- workspace and mission;
- current mission authority epoch;
- live worker process at that exact epoch;
- persisted mission checkpoint;
- hash of the exact original text; and
- expiry no more than 24 hours in the future.

The strict nudge input and persisted row contain no scope, capability, budget, credential, or tool grant. Issuing a nudge does not mutate any mission contract or authority table. Worker delivery must recheck the epoch and expiry.

## Lifecycle channels

Notes, leads, primitives, findings, and drafts retain caller-supplied stable UUIDs. Each channel has explicit initial states and legal transition edges enforced in both the domain service and PostgreSQL. Immutable lifecycle facts drive a separate current-state projection.

## Telemetry and triage

Telemetry facts are immutable, idempotent, and grouped by mission, worker, phase, activity, skill, and model. They account for tokens, context, cache hits and cache-hit tokens, tool/effect calls, requests, callbacks, wall time, and cost. Authentication-loop requests/spend, false-positive outcomes, oracle outcomes, and high-confidence alerts are dedicated counters rather than labels hidden in payloads.

Alerts retain stable UUIDs, authoritative source cursors, confidence, severity, legal triage state, redacted summary, and explicit confirmed/false-positive/oracle outcomes. Active alert reads are ordered by confidence, severity, source cursor, and ID for deterministic operator triage.

All endpoints are admin-tier, require credential-authenticated operator access, and are excluded from MCP.
