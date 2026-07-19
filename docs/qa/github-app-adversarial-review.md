# GitHub App integration adversarial review

Review scope: `feat/github-app-integration` through Gate 6 remediation 7. No live service, database, GitHub/provider API, infrastructure, DNS, policy, merge, deployment, push, PR, workflow, or other remote mutation was performed.

## Authority and security conclusions

| Threat | Control / result |
|---|---|
| Autonomous localhost/provider bypass | PATH wrappers are explicitly defense in depth, not the boundary. Absolute interpreters still execute, but child environments omit DB/vault/App/PAT/operator authority. Every workspace GitHub mutation, manual status, delivery-policy action, and webhook DLQ replay requires a non-local authenticated principal or the preimage of a configured operator-capability digest even when `AUTH_REQUIRED=false`. No-Origin/direct-socket requests without that capability fail before credential resolution. |
| Workflow/deployment or legacy status actuation | Workflow dispatch returns conflict without credential resolution; Actions permission is read-only. Automatic PR compliance and CI-autofix statuses are local/WAL-only. Deployment authority remains absent. The exact terminal Check Run reconciler is the only automatic provider projector. |
| Mutable result/spec escalation | Full runs freeze all selected non-excluded stories independently of file pass flags. Fallback/compatibility rows are proposal-only. Production-worker duplicate recovery compares the complete immutable trusted-WAL payload, including attestation id, digest, passed time, expiry, and all stable fields; it remains read-only. |
| SHA ambiguity | `GitShaSchema` is the shared 40-hex contract for SSDLC subjects/lineage and repository/release authority. The upgrade migration enforces new commit-subject writes with `NOT VALID`; historical 64-hex audit rows remain stored but cannot authorize runtime release. |
| Exact PR head race | Non-direct release pushes a unique run-owned provider ref. PR create/finalize rereads that ref immediately before mutation, verifies exact head/ref afterward, and closes/quarantines a raced PR. Tests cover A→B before/during create and before/during draft finalization. |
| Direct-base race/crash | Intent freezes exact base repository/branch/SHA and deterministic integration checkout. Repository-wide local/provider locks serialize runs. Integration occurs in an isolated checkout; crash-left `MERGE_HEAD`/index is aborted to the frozen base. Provider push uses force-with-lease CAS, local base uses exact `update-ref` CAS, and every replay verifies exact ancestry/result. |
| Release split-brain/retry | Intent insertion, immutable terminal checkout/path attestation, and `release_pending` transition are one transaction with affected-row checks. Fresh and retry success preserve exact options/predecessor authority and use the same reconciler. Historical manual retry-merge and arbitrary worktree merge/preview return truthful conflict before mutation. |
| Cleanup/relay recovery | Exact cleanup treats an already absent and unregistered authorized worktree as completed. Completed cleanup is gated and cannot be rerun/downgraded after relay failure. Public `done` and exact terminal-outbox readiness are atomic. Startup drains bounded intents before stale classification, all extant intents are excluded from stale/orphan scans, and periodic reconciliation retries bounded batches. |
| Check Run duplicate uncertainty | Discovery requires an array plus a stable nonnegative safe `total_count` exactly consistent with pagination. Missing, malformed, under-reported, changing, ambiguous, or truncated responses remain uncertain and never create a duplicate. |
| App authority/cross-talk | App-selected repository/installation identity remains exact and cannot downgrade to PAT/OAuth. Legacy credentials are accepted only when the canonical authority view explicitly selects no-App fallback. Purpose tokens are resolved last and never exposed to execution children. |
| Webhook/CSRF/secrets/OVH | Raw-byte HMAC, replay/freshness claims, exact installation/repository identity, CSRF normalization, encrypted vault storage, and exact OVH host/path/method/body-limit artifacts remain intact. |

## Durable release contract

A successful run requires complete frozen host result, closeout, commit, accounting, checkpoint-attestation, trusted-outbox, branch/worktree, and final-HEAD authority. Before any effect, Rorca persists a versioned immutable intent with source SHA, base branch/SHA, workspace/worktree realpaths, isolated integration path, unique provider release ref, strategy/safety options, and exact repository/App identity.

Release steps carry durable processing/terminal states under the immutable identity. Provider push/PR effects reconcile by exact refs; isolated merge reconciles by persisted checkout and commit marker; local/provider base updates use CAS; cleanup is exact-intent idempotent; terminal relay is retryable after atomic public completion. `direct`, `pr`, `draft-pr`, and `branch-only` retain their behavior only through this seam. ANSI, PTY, and native-PTY transport is unchanged.

## DB-free QA evidence (2026-07-18)

The final counted command uses the isolated Jest config with no DB setup/teardown and unreachable `127.0.0.1:1/forbidden_test`: **39/39 suites, 320/320 tests passed**. It covers capability/no-Origin/absolute-interpreter containment, exact WAL fallback, 40-hex SSDLC contracts, strict Check discovery, atomic release preparation, repository locking, direct merge crash/replay/base races, safe local-CAS recovery, provider CAS, PR A→B races/quarantine, real reconciler cleanup/relay transitions, all retry strategies, App no-downgrade, migrations, and legacy projector retirement.

Root and backend TypeScript passed; focused GitHub Settings Vitest passed **1 file / 9 tests**. Changed-file ESLint passed with zero errors and the two inherited startup `console` warnings. Tier lint passed (117 public, 49 auth, 17 paid, 59 admin, 282 default-denied, 166 MCP-exposed); public contract stability passed against `38b4250f93222fd2bba331591f6475cb7bc493d6`; 1,231-file license checks passed; the single-license boundary check skipped as designed; Swagger lint exited zero with the same nine baseline warnings. Both OVH YAML files and merged Compose configuration parsed (only the expected unset `COOLIFY_FQDN` warning). Static migration checks found **188 files / 188 unique prefixes**, latest `20260718170000_gate6_release_contract.sql`, no new `pgboss.*` access, and all new explicit identifiers below 63 bytes.

No DB-backed suite or migration was executed. Two exploratory legacy route-suite invocations reached only the deliberately unreachable test URL and failed before any database connection/mutation; they are not counted. PostgreSQL 16 fresh/dirty upgrade, live GitHub Manifest/token/webhook/ref/PR behavior, branch protection, and deployed OVH ingress remain separately authorized staging requirements.

## Operational constraints

- Configure only `RORCA_OPERATOR_CAPABILITY_SHA256` on a local-mode server and supply the preimage per provider mutation; never place the preimage in child environment, repository files, logs, or shell history.
- Historical Actions-write App bindings fail closed after migration. An authorized staging ceremony must downgrade the provider App to Actions-read and revalidate exact selected-repository bindings.
- Registration/import does not install the App, bind a repository, activate policy, merge, dispatch, or deploy.
- App secret rotation remains a separate audited replacement ceremony; retained ciphertext/identity is never overwritten.
- OVH/Traefik artifacts are review-only and were not applied.
