# GitHub App integration adversarial review

Review scope: `feat/github-app-integration` through the final authority/durability remediation. No live service, database, GitHub/provider API, infrastructure, DNS, policy, merge, deployment, push, PR, or other remote mutation was performed.

## Authority and security conclusions

| Threat | Control / result |
|---|---|
| Agent-written result/status escalation | Every fallback `pass`, `fail`, `skip`, and `excluded` row is proposal-only. Replay can recognize only an exact pre-existing immutable host result; it cannot insert terminal authority. Compatibility HTTP rows are explicitly non-governing and return `governing: false`. Governing queries select only allowed host provenance/source. |
| Mutable spec/snapshot promotion | Full runs freeze every selected non-excluded story regardless of pre-seeded/forged `passes:true`; the run projection clears those selected flags before execution. Explicit story-only scope is separate. Worker `done` and every release effect require complete exact host authority; files never grant predecessor authority. |
| Forged skip/exclusion | Expected executable stories are frozen separately from host-owned exclusions. The DB freezes disjoint expected/excluded arrays together with workspace/spec/branch/worktree identity. A non-excluded expected story must have an exact host integrated pass for success; journal/compatibility skip or exclusion never masks it. |
| Branch/worktree drift | Queue payload, worker spawn, engine finalization, integrated transaction, recovery, release, and terminal projection bind DB-frozen workspace/worktree realpaths, registered worktree identity, symbolic branch, and exact HEAD. Result worktree identity must equal the frozen run checkout. Direct cleanup records separate mutable state and preserves immutable terminal checkout/SHA attestation. |
| Multi-story worker crash | Startup first reconciles immutable unreleased pass state, consumes retained deterministic run-root journals, then rescans before stale-run decisions. An earlier relay-failed pass may release after a later pass only when all exact host successors form one ordered ancestry chain ending at current canonical HEAD and all outbox/attestation/projection identities match. |
| Trusted WAL duplicate/crash | Concurrent delivery of one WAL id awaits one shared in-flight durable promise. A production worker may read-compare an exact immutable host duplicate but cannot insert/promote it. One durable release intent persists exact SHA and terminal intent before public `done`; pending/processing steps and terminal relay reconcile at worker startup. |
| SHA width ambiguity | Git/GitHub authority exposes only full 40-hex commit ids. Execution finalization, canonical result persistence, repository/release normalization, manual status routes, job schemas, and SSDLC commit subjects reject 64-hex values before host finalization/provider authority. Checkpoint attestations remain consistently 40-hex. |
| Process-global App seizure | Manifest start/exchange and bounded import require both workspace administration and explicit platform/superuser authority. Ordinary workspace admins receive 403. Configured App owner/creation organization is checked against the provider App owner when present. Admin tier and MCP exclusion remain unchanged. |
| Credential downgrade/cross-talk | Story commits remain local and autonomous general/conflict shells deny remote Git/SSH, `gh`, and network commands with user/system Git config disabled. One locked host release seam reacquires exact repository authority and resolves purpose credentials last. App authority cannot downgrade; legacy workspace PAT/OAuth is used only when canonical authority explicitly selects fallback. No ambient `gh`, helper, or SSH release path remains. |
| Webhook abuse | Exact path/method, 1 MiB bounds, raw-byte HMAC, freshness, replay claim fencing, event allowlist, exact installation/repository/App identity, CSRF normalization, DLQ provenance, and secret containment remain intact. |

## Durable release contract

A successful terminal run requires every frozen non-excluded expected story to have one latest allowed host `pass` with:

- `integrated = TRUE`, host/execution-engine provenance, accepted matching closeout and manifest;
- one exact story commit projection on `pipeline_runs.branch_name`;
- exact keyed accounting identity (or an explicit no-accounting identity) and one matching token projection when required;
- exactly one immutable host `story_passed` outbox, released only after local projection;
- exactly one non-revoked execution-engine checkpoint attestation;
- ordered ancestry through all integrated results to the exact registered canonical branch HEAD.

The exact branch/HEAD check is repeated under a local run/repository lock in every merge, push, PR/finalize, and reviewed-merge actuator/callee, before canonical repository authority and again after purpose-token resolution immediately before effect. Release steps are claimable/idempotent; workflow/deployment authority is disabled. Failure, timeout, or host skip can describe a failed terminal run but can never satisfy successful release. Frozen exclusions are policy state, not result-journal state.

## Reproduced DB-free QA evidence (2026-07-18)

- Isolated backend Jest configuration with no global DB setup/teardown and an unreachable PostgreSQL URL: **24 suites / 146 tests passed**. Coverage includes general-profile remote-command denial, pre-seeded pass scope, payload/DB worktree mismatch, exact production-worker duplicate verification, HEAD races across release purposes, App no-downgrade, direct-cleanup terminal attestation, release crash/restart convergence, paginated uncertain Check discovery, and 40-vs-64 SHA rejection.
- Root TypeScript and backend TypeScript (`--noEmit --incremental false`) passed.
- Focused GitHub Settings frontend Vitest passed **1 file / 9 tests**.
- Changed-file ESLint passed with the two inherited startup `console` warnings. Tier lint, public contract stability, 1,220-file license checks, Swagger coverage (nine baseline warnings), OVH YAML/Compose static validation, migration prefix/order checks, and `git diff --check` passed as recorded in the final remediation report.
- Static migration inventory is **187 SQL files / 187 unique numeric prefixes**; latest is `20260718160000_host_release_authority.sql`. No integration migration touches `pgboss.*`.

No DB-backed tests or PostgreSQL migration execution were run. Real PostgreSQL 16 trigger/concurrency/upgrade behavior, live GitHub Manifest/token/webhook behavior, and provider/network uncertainty remain operationally unproven and require separately authorized staging evidence.

## Operational constraints

- Registration/import does not install the App, bind a repository, activate policy, merge, or deploy.
- App secret rotation remains a separate audited ceremony; do not overwrite retained ciphertext or secret references.
- Story commit statuses are intentionally disabled. The durable `Rorca Pipeline` Check Run is the governing GitHub lifecycle projection; explicit admin manual statuses remain non-governing.
- OVH/Traefik artifacts are review-only and were not applied.
