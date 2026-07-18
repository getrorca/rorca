# GitHub App integration adversarial review

Review scope: `feat/github-app-integration` through the final authority/durability remediation. No live service, database, GitHub/provider API, infrastructure, DNS, policy, merge, deployment, push, PR, or other remote mutation was performed.

## Authority and security conclusions

| Threat | Control / result |
|---|---|
| Agent-written result/status escalation | Every fallback `pass`, `fail`, `skip`, and `excluded` row is proposal-only. Replay can recognize only an exact pre-existing immutable host result; it cannot insert terminal authority. Compatibility HTTP rows are explicitly non-governing and return `governing: false`. Governing queries select only allowed host provenance/source. |
| Mutable spec/snapshot promotion | Run/retry files are projections only. Worker `done`, retry synchronization, merge/push/PR/finalization, reviewed delivery, and workflow dispatch require frozen expected scope plus exact host result, closeout, commit, attestation, accounting, released outbox, branch, terminal HEAD, and matching lifecycle flags. Future-story pass/exclusion tampering or exit zero cannot promote a run. Pre-success draft PR creation was removed. |
| Forged skip/exclusion | Expected executable stories are frozen separately from host-owned exclusions. The DB freezes disjoint expected/excluded arrays together with workspace/spec/branch/worktree identity. A non-excluded expected story must have an exact host integrated pass for success; journal/compatibility skip or exclusion never masks it. |
| Branch/worktree drift | Integrated pass finalization, crash recovery, terminal acceptance, and pre-token Check Run reconciliation verify repository top-level/common Git dir, registered worktree, symbolic `pipeline_runs.branch_name`, result/commit/checkpoint branch, ordered commit ancestry, and exact current HEAD. Branch switches, unrelated commits, detached/mismatched worktrees, and terminal drift fail closed. |
| Multi-story worker crash | Startup first reconciles immutable unreleased pass state, consumes retained deterministic run-root journals, then rescans before stale-run decisions. An earlier relay-failed pass may release after a later pass only when all exact host successors form one ordered ancestry chain ending at current canonical HEAD and all outbox/attestation/projection identities match. |
| Trusted WAL duplicate/crash | Concurrent delivery of one WAL id awaits one shared in-flight durable promise. Failed acceptance is forgotten and retryable; only successful durable acceptance is remembered. Terminal Check Runs retain their claimable/restart-reconciled ledger. Per-story commit statuses were removed from trusted/governing semantics rather than acknowledging detached provider operations. |
| SHA width ambiguity | Git/GitHub authority exposes only full 40-hex commit ids. Execution finalization, canonical result persistence, repository/release normalization, manual status routes, job schemas, and SSDLC commit subjects reject 64-hex values before host finalization/provider authority. Checkpoint attestations remain consistently 40-hex. |
| Process-global App seizure | Manifest start/exchange and bounded import require both workspace administration and explicit platform/superuser authority. Ordinary workspace admins receive 403. Configured App owner/creation organization is checked against the provider App owner when present. Admin tier and MCP exclusion remain unchanged. |
| Credential downgrade/cross-talk | Current App binding wins even when invalid/disabled; it never downgrades to PAT/OAuth/ambient credentials. PAT/OAuth remains available only where no App binding exists. Installation, App, selected repository id/name/account, and purpose-specific permission identity remain exact. |
| Webhook abuse | Exact path/method, 1 MiB bounds, raw-byte HMAC, freshness, replay claim fencing, event allowlist, exact installation/repository/App identity, CSRF normalization, DLQ provenance, and secret containment remain intact. |

## Durable release contract

A successful terminal run requires every frozen non-excluded expected story to have one latest allowed host `pass` with:

- `integrated = TRUE`, host/execution-engine provenance, accepted matching closeout and manifest;
- one exact story commit projection on `pipeline_runs.branch_name`;
- exact keyed accounting identity (or an explicit no-accounting identity) and one matching token projection when required;
- exactly one immutable host `story_passed` outbox, released only after local projection;
- exactly one non-revoked execution-engine checkpoint attestation;
- ordered ancestry through all integrated results to the exact registered canonical branch HEAD.

The exact branch/HEAD check is repeated after durable terminal projection claim and before repository authority or token resolution. Failure, timeout, or host skip can describe a failed terminal run but can never satisfy successful release. Frozen exclusions are policy state, not result-journal state.

## Reproduced DB-free QA evidence (2026-07-18)

- Isolated backend Jest configuration with no global DB setup/teardown: **36 suites / 254 tests passed**. Coverage includes proposal-only status variants, future-story file tampering, exit-zero refusal, branch switch/HEAD drift, two-story relay failure plus later descendant plus startup recovery, duplicate in-flight durable acceptance/retry, 40-vs-64 SHA rejection, and platform-admin authority.
- Root TypeScript and backend TypeScript (`--noEmit --incremental false`) passed.
- Focused GitHub Settings frontend Vitest passed **1 file / 9 tests**.
- Changed-file ESLint, tier lint, public contract stability, license checks, Swagger coverage, OVH YAML/Compose static validation, migration prefix/order/identifier checks, and `git diff --check` passed as recorded in the final remediation report.
- Static migration inventory is **186 SQL files / 186 unique numeric prefixes**; latest is `20260718150000_github_run_authority_remediation.sql`. No migration touches `pgboss.*`.

No DB-backed tests or PostgreSQL migration execution were run. Real PostgreSQL 16 trigger/concurrency/upgrade behavior, live GitHub Manifest/token/webhook behavior, and provider/network uncertainty remain operationally unproven and require separately authorized staging evidence.

## Operational constraints

- Registration/import does not install the App, bind a repository, activate policy, merge, or deploy.
- App secret rotation remains a separate audited ceremony; do not overwrite retained ciphertext or secret references.
- Story commit statuses are intentionally disabled. The durable `Rorca Pipeline` Check Run is the governing GitHub lifecycle projection; explicit admin manual statuses remain non-governing.
- OVH/Traefik artifacts are review-only and were not applied.
