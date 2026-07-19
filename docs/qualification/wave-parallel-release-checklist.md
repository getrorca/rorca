# Wave-parallel independent safety review and PR-only release checklist

**Release status: blocked until completed by independent named humans.** This document is a gate template, not an approval. Approval of an implementation spec, passing terminal output, merge, deployment, or a qualification receipt does not approve this checklist or production activation.

The canonical machine gate is `rorca.wave-release-readiness/v1` in `backend/src/lib/wave-release-readiness.ts`. The immutable packet must bind the current qualification receipt and every check below to the pull-request head. Any skipped critical scenario, stale receipt/review/check, safety ambiguity, missing durable evidence, unresolved critical/high finding, enabled auto-merge/deployment, or missing rollback proof blocks publication.

## Independence and evidence rules

Seven distinct named humans must approve the exact PR head: **architecture**, **security/red-team**, **database/queue**, **Git**, **SRE**, **QA**, and **operator UX**. None may be the implementer, and one person may not fill multiple required roles. Every checklist row also names an independent checker that is not the implementer. The implementer cannot self-approve the packet.

Accepted authoritative evidence is content-addressed and durable: database/WAL rows, append-only qualification/governance records, Git objects/refs/tree inventories, CI artifacts tied to the PR SHA, and independent checker output stored as an artifact. Terminal output and implementer assertions are supporting context only. Evidence must be bounded and redact credentials, secrets, prompts, payloads, private paths, and stack traces.

## Required mapping

Replace each `TBD` with the immutable assertion/evidence digest, checker identity, and named reviewer in the packet. Scenario IDs may be expanded but not removed.

| Requirement ID | Required scenario(s) | Required assertion | Durable evidence | Independent checker | Human review |
|---|---|---|---|---|---|
| `architecture-state-machine` | `WPE-Q-006`, `WPE-Q-007`, `WPE-Q-008`, `WPE-Q-009` | Legal reference transitions; canonical wave/story order; exactly one finalization; accepted siblings remain accepted on partial failure; transitive failed dependencies never start; retries have new attempt lineage; one integration linearizer; process exit cannot imply semantic success | DB/WAL transition and finalization trace + Git topology digest | `TBD` | architecture: `TBD` |
| `security-data-safety` | `WPE-Q-001`–`WPE-Q-005`, `WPE-Q-010` | Child environment contains only allowlisted test values; server proves dedicated owner role/database; no production fallback; paths/branches/commands are allowlisted; output is bounded/redacted; fences reject drift; receipt authentication and separate rollout authority reject forgery | DB identity/privilege proof, before/after protected inventory digest, redacted diagnostic artifact, receipt verification audit | `TBD` | security/red-team: `TBD` |
| `database-queue-safety` | `WPE-Q-001`, `WPE-Q-003`, `WPE-Q-004`, `WPE-Q-006` | Dedicated role owns isolated DB and has no elevated role flags; numbered SQL placeholders and awaited DB calls; uniqueness/transaction boundaries hold; `boss.createQueue` precedes send; job IDs are generated UUIDs; no application migration manages `pgboss.*` | PostgreSQL 16 fresh-DB migration record, schema constraints, queue inventory and DB/WAL rows | `TBD` | database/queue: `TBD` |
| `git-sre-recovery` | `WPE-Q-006`–`WPE-Q-009` | Parent head/source ancestry/manifest are guarded; normal failure is branch-only; dirty work is preserved exceptionally; cleanup is idempotent; restart reconciliation, cancellation, caps, telemetry, halt, drain and rollback pass | Git object/ref/worktree inventories, recovery refs, WAL/governance audit, resource samples | `TBD` | Git + SRE: `TBD`, `TBD` |
| `ci-platform-matrix` | `WPE-Q-001`–`WPE-Q-010` | Node 20 and 22 pass on Linux and macOS with PostgreSQL 16 and exact test-role ownership; no critical skip | Four SHA-bound workflow artifacts and isolated DB cleanup records | `TBD` | QA: `TBD` |
| `nonproduction-canary-soak` | full deterministic profile + canary + soak | Non-production only; bounded duration/load; first failure remains authoritative; one automatic diagnostic retry; zero leak/divergence/unresolved critical-high count | Canary report, soak report, resource/queue/Git/DB final inventory | `TBD` | QA + SRE: `TBD`, `TBD` |
| `evidence-release-checklist` | all | Every requirement and all `WPE-INV-001`–`007` map to non-empty scenario/assertion/durable-evidence/checker/reviewer fields | Canonical packet hash and append-only packet row | `TBD` | architecture: `TBD` |
| `independent-reviewers` | all review scopes | Seven distinct reviewers; no implementer reviewer/checker; all review the exact head; no unresolved critical/high finding | Reviewed PR-head attestations and evidence digests | `TBD` | all roles: `TBD` |
| `pr-validation` | final PR | Fresh DB + uniqueness, frontend/backend typecheck, focused/full tests, frontend/backend lint, build, contract/tier, license, secret scan, `git diff --check`, qualification report all pass on exact head | Required-check artifacts and generated report hash | `TBD` | QA: `TBD` |
| `pr-only-delivery` | release controls | Reviewed PR only; auto-merge false; deployment false; implementation/spec/receipt not activation; separate operator acts only after all gates | PR settings snapshot/digest + append-only activation record (created later, not by this PR) | `TBD` | operator UX: `TBD` |
| `rollback-rehearsal` | halt + drain + cancel + replay | Disabling opt-in immediately blocks new parallel dispatch; in-flight evidence is unchanged; governed drain/cancel work; queue replay revalidates; sequential execution remains available | Before/after governance audit, run/WAL evidence, sequential control run | `TBD` | SRE + operator UX: `TBD`, `TBD` |
| `zero-production-mutation` | `WPE-Q-004`, `WPE-Q-005` | Qualification creates/cleans only its unpredictable namespace; protected production inventory has identical before/after digest and zero mutation count in every category | Independently captured DB/WAL/Git/queue/operator before/after inventory + namespaced cleanup artifact | `TBD` | security + database + Git: `TBD`, `TBD`, `TBD` |

## Review questions

### Architecture

Confirm the reference state machine rejects every illegal transition; wave index and story ID determine integration order regardless of completion order; finalization uniqueness is durable; partial-wave success never becomes whole-run success; dependency closure is transitive; retries use explicit attempt lineage; only one guarded integrator can advance the parent; and child/process completion is distinct from semantic story/run closeout.

### Security and data safety

Confirm qualification child credentials are sanitized; the server-reported database, role, owner, marker, and `application_name` exactly match the unpredictable namespace; no `DATABASE_URL`, test URL, provider, cloud, Git, workspace, or production fallback is inherited; repository/scenario/worktree/branch paths are contained and allowlisted; child commands use fixed executables/argv with `shell:false`; diagnostics are bounded and redacted; every queue/worker/runner spawn revalidates its fence; receipts require a trusted issuer signature and current local identity; and a receipt/review packet alone cannot create rollout authority.

### Database and queue

Confirm PostgreSQL access is async and uses `$1…$n`; transaction, uniqueness, idempotency, and append-only boundaries hold on a fresh PostgreSQL 16 database; the dedicated non-superuser role owns only its test DB; there is no production fallback; queues are explicitly created through `boss.createQueue`; pg-boss generates UUID job IDs while run IDs remain data payload fields; and neither migrations nor application cleanup issue DDL/DML against `pgboss.*`.

### Git and SRE

Confirm parent-head, source-ref, ancestry, clean-index and frozen-manifest checks precede integration; ordinary failure leaves recoverable branch/ref evidence rather than mutating the parent; exceptional dirty work is snapshotted before cleanup; repeated cleanup is safe; crashes reconcile from durable states; cancellation reaches descendants; process/output/DB/memory/disk/concurrency budgets are bounded and observable; threshold breach halts canary dispatch; drain/cancel preserve evidence; and rollback denies replayed/stale envelopes.

### QA and operator UX

Confirm status says why parallelism is unavailable (`receipt-missing`, `receipt-stale`, `review-missing`, `activation-missing`, `halted`, or `draining`) without presenting an environment flag as proof. Instructions must distinguish stage, activate, drain, cancel and rollback, show bounded cohort/caps, and keep sequential execution obvious and available.

## Blocking CI and platform policy

`.github/workflows/wave-qualification.yml` is a PR-only blocking matrix for Linux and macOS, Node 20/22, and PostgreSQL 16. Each job provisions an exact `rorca_qtest_<token>` database owned by `rorca_qrole_<token>`, records the required marker, runs fresh migrations, exercises real pg-boss queue creation through the qualification runner, runs the deterministic profile, and tears down only the exact namespaced role/database. Credentials are random, masked, and passed only through the qualification URL.

Critical wave tests may not be skipped. If a future OS cannot execute a signal/process scenario, the packet must identify the skip as non-blocking, give a written platform rationale, and bind equivalent model/integration coverage. A missing equivalent artifact is a critical skip and blocks the packet.

## Canary, bounded soak, and rollback rehearsal

1. Use only a disposable non-production workspace, repository, queue namespace, role and database. Capture protected DB/WAL/Git/queue/operator inventory before mutation.
2. Run a bounded canary with one allowlisted workspace/run, parallelism 2, global/workspace cap 1, and strict CPU/memory/error thresholds. A breach must append an automatic halt and prevent the next spawn.
3. Run the bounded soak profile. Preserve first-attempt failure; perform at most the declared automatic diagnostic retries; never convert a flaky first attempt into release success. Require final resource counts at baseline/zero, no unexplained state divergence, and no unresolved critical/high finding.
4. Rehearse drain, explicit cancellation, and rollback. Disable production opt-in and prove the next parallel dispatch is denied immediately; prove active evidence rows/refs are unchanged; drain or cancel through governed APIs; replay a stale queue envelope and require denial; run one sequential control successfully.
5. Capture the protected inventory again. Independent security, database and Git reviewers must attest identical digests and zero mutation for existing workspaces, specs, runs, story evidence, queues, branches, WAL, receipts, rollout controls and operator records.
6. Clean only exact ownership-marked test rows, queues, refs, worktrees, database and role. Never delete, truncate, reset, rewrite, relabel, or otherwise mutate pre-existing records.

## Final PR gate

The exact PR head must pass migration uniqueness and fresh-database migration, frontend/backend typechecks, focused and full tests, frontend/backend lint, build, contract/tier checks, license checks, secret scan, `git diff --check`, and generated qualification report creation. Auto-merge and all deployment workflows remain disabled for this delivery.

After all evidence and independent reviews exist, an operator may append the readiness packet. Production still remains disabled. A different operator—neither implementer nor required reviewer—must later submit the exact `AUTHORIZE_WAVE_PARALLEL_PRODUCTION` confirmation plus an HMAC-SHA-256 authorization bound to workspace, packet hash, source revision and operator. The API verifies it with the independently managed `RORCA_WAVE_PRODUCTION_ACTIVATION_KEY` (minimum 32 bytes) and stores only its digest. Rollout configuration still requires the matching receipt, packet, approval, cohort, allowlist and caps. Activation, merge and deployment are separate decisions.
