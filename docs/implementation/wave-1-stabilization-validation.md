# Wave 1 stabilization remediation-5 validation packet

Status: **historical remediation-5 packet; superseded by final provider-neutral remediation**

This packet is retained only as historical provenance for source `e363f083d4ec6dd0c84b465f0f1b9325711f6bb9` and old spec `0934cdff…`. It is not current Wave 1 evidence. Current authority binds exact start `407752564e654e1bc8d83af4d9f5154f6807f307`, revised spec `caeb0720cd09f4e6a5cd22b078b2d50932b34613262c15631cdf71af9c056920`, and a fresh dynamic disposable local proof fixture. Coverage was reset and must not retain this packet as validation.

This packet records implementation provenance only. It is not approval, lifecycle evidence, provider consent, merge/deployment authority, or permission to touch a live run.

## Frozen authority and safety boundary

- Baseline: `a5033e645b5935032a0420ef7339d197df8bae7b`
- Remediation-5 starting SHA: `1a3d1e2ee032e6d81f39525a939a217b34577228`
- Validated implementation source: `e363f083d4ec6dd0c84b465f0f1b9325711f6bb9`
- Branch: `feat/governed-mission-waves-1-4-pi-20260727`
- Repository: `https://github.com/getrorca/rorca.git`
- Spec: `forge/specs/pending/wave-1-stabilize-evidence-closeout-and-managed-branch-delivery.json`
- Spec SHA-256: `0934cdff26bc35d72af84e958114b322186e1b21adacae510fb7fd9ee404425d`
- Deferred legacy managed-run identity, ineligible and not a local proof fixture: `20260316000550`
- Permanently protected identity: `20260316000549`

No live/shared database, service, provider, GitHub, Genesis, remote branch, PR, Check Run, merge, workflow, deployment, or other worktree authority was read or mutated. Wave 2 was not started.

## Rereview defects closed

### Immutable complete attempt authority and legacy fail-closed upgrade

Forward migration 245 replaces the attempt-envelope update trigger with the complete remediation-3/4 identity: canonical/run-spec paths, revisions and byte hashes; manifest/spec/story revisions; base, expected, and observed Git SHA; expected and observed branch; and the remaining repository/worktree/runtime identity. A table-driven DB test attempts to alter every new and ancestry-bearing field after finalization and proves PostgreSQL rejects each mutation.

An upgrade-safe `NOT VALID` check preserves historical rows while requiring every new or updated successful envelope to carry internally exact non-null authority. The accepted-closeout trigger, direct successful-attempt selector, and `inspectRunHostAuthority` independently require the complete binding. A populated 244-shaped fixture executes exact migration 245 and proves a legacy successful null envelope remains stored but cannot be changed or authorize accepted closeout. Run closeout/release inherit the same fail-closed `inspectRunHostAuthority` projection.

### Database-enforced enduring conflict poison

`host_story_attempt_conflicts` now has a database trigger denying UPDATE and DELETE. The DB lane first establishes a genuinely complete, release-eligible run, appends a post-finalization conflict, proves both alteration and deletion fail for the non-superuser application owner, proves the exact row remains unchanged, and then re-proves direct success, run closeout, and release remain disqualified.

### Retained remediation-4 controls

#### One run-owned execution snapshot

Fresh and retry dispatch both copy one canonical byte observation into a run-owned immutable execution snapshot. Run, manifest, story, and provider-attempt revisions describe that exact payload. Worker and story-pass recovery consume the persisted run-spec path instead of reconstructing a canonical-path assumption.

#### Every-attempt filesystem and Git authority

Immediately before every distinct provider attempt, production code re-observes canonical/run-spec files, JSON and story revisions, repository/worktree paths, exact HEAD and branch, and base ancestry. Missing, unreadable, invalid JSON, moved, symlinked, or path-escaped files are recorded as immutable conflicts before egress is refused. Canonical drift, run-spec drift, HEAD drift, branch drift, and ancestry drift are likewise immutable conflicts.

Any unresolved conflict for an expected story now removes authoritative passes and disqualifies host authority, closeout, and release—even when the conflict is recorded after a prior success/finalization.

#### Actual retry-worker composition

The DB lane invokes exported production `handlePipelineRetry` with PostgreSQL and a real child process fixture. It proves duplicate delivery fencing, lease-loss termination, live-PID refusal, dead-PID recovery, crash recovery before launch and after durable result/integration, cancellation before launch, and mixed passed/failed scope without relaunching a passed story.

#### Populated migration fixture

The binding suite creates a genuine populated 242-shaped schema, executes exact migration 243, and verifies legacy release-fence backfill and final 243 schema shape. Claims are limited to that proved 242→243 transition; all 245 migrations are separately applied from empty in the final authority.

#### Protected Genesis worker entry points

The exported production `pipeline:run`, `pipeline:retry`, and `pipeline:cancel` handlers batch-preflight every valid run identity before dispatch claims, selectors, reads, writes, locks, or generic failure terminalization. Stale-job, orphan, reconciliation, PTY, and DLQ selectors explicitly exclude the protected ID. `worker-protected-wave1-entrypoints.test.ts` invokes the actual worker handler and proves a valid delivery for `20260316000549` performs zero DB access.

#### Provider-attempt authority envelope

Dispatch freezes exact canonical source, run-owned execution snapshot, expected Git SHA/branch, and dispatch fence. Every distinct provider attempt independently re-observes these identities and records either verified authority or an immutable typed conflict under `pipeline-run-authority:<runId>`. Exact idempotent replay does not create a new provider attempt.

The PostgreSQL provider-child suite covers success, nonzero exit, timeout, cancellation, crash, exact replay, repeated-attempt Git/spec drift, branch/ancestry mismatch, all bounded file/path/JSON observation failures, a different same-repository worktree, stale generation, changed identity, and conflict poisoning after finalization.

#### Cancellation, release, publication, and retry leases

Ordinary release preparation, the release-pending transition, every release step, terminal publication, public-done CAS, completion, and startup recovery reacquire the canonical run fence and validate the exact dispatch fence, status, and durable cancellation evidence. Failure paths do not manufacture or revive release authority.

Governed retry publication self-fences. Production retry execution has PostgreSQL-owned lease claim, executing transition, process/PID binding, and renewal boundaries. Stale owners cannot partially replace launch identity; canonical PID and dispatch launch identity commit together or roll back. Renewal stops when canonical cancellation appears. Final DB composition tests cover duplicate workers, cancellation at release boundaries, publication racing cancellation/closeout, stale leases, lease loss, crash before/after launch, restart, stale-owner/PID rejection, one writer/PID, and mixed passed/failed retry scope.

#### Test-database freshness

Freshness is invocation-bound and claimed with one connection, one transaction, and a database-scoped advisory lock. Reuse checks include all caller-created schemas/tables, including pg-boss-only state. The durable database comment and emptiness decision commit together. Concurrent unit claims prove exactly one winner.

#### Packed Pi/MCP runtime parity

The parity lane performs a real `npm pack`, isolated `npm install`, and installed launcher execution. It starts the actual MCP server, discovers `tools/list`, compares request schemas with the packaged contract/public schema, proves malformed requests are not forwarded, and exercises the shared production 1 MiB body limit through an actual HTTP 413 response. Source-grep and checked-snapshot-only evidence are not used as substitutes.

## Authoritative PostgreSQL 16 result

The final source was tested against an isolated authority using exact image ID `sha256:88d22bdc29398d11b7c2b5ded40393de4372097f2d07207e9742a306aa2d8215`:

- PostgreSQL 16.14
- pgvector 0.8.1
- AGE 1.5.0
- Database: `rorca_wave1_rem5_20260728075617f0435fb6_test`
- Owner/user: `rorca_wave1_rem5_20260728075617f0435fb6_owner`
- Role: login; `rolsuper=false`; `rolcreatedb=false`; `rolcreaterole=false`
- Canonical migrations: 245 applied / 0 skipped
- Result: 4 suites / 26 tests passed together in one final fresh exact-source invocation
- Log: `/tmp/rorca-wave1-rem5-final-db-authoritative.log`
- Database attestation: `/tmp/rorca-wave1-rem5-final-db-attestation.log`
- Source/hash attestation: `/tmp/rorca-wave1-rem5-final-source-attestation.log`

This is one non-aggregated final-source result. One earlier consumed diagnostic authority exposed only a CHAR(40)/TEXT fixture-parameter typing defect after three suites had passed; it is not counted. Pre-connection setup/harness refusals mutated no test database. The complete ledger is in `/tmp/rorca-wave1-remediation5-progress.md`.

The exact isolated container, network, bind root, secret state, and port listener were removed. All cleanup checks returned zero/absent in `/tmp/rorca-wave1-rem5-final-db-cleanup.log`. No prune or shared-resource mutation was performed.

## Broad validation

Passed on remediation-5 source, except where explicitly marked as retained unaffected remediation-4 evidence:

- multi-package TypeScript typecheck: frontend, backend, CLI, Pi extension, public contract, capture;
- Wave backend unit lane: 15 suites / 135 tests;
- final combined PostgreSQL lane: 4 suites / 26 tests;
- full frontend Vitest retained from remediation 4: 89 files / 1,040 tests (backend-only remediation 5 did not rerun this unaffected lane);
- full Pi extension Vitest retained from remediation 4: 19 files / 147 tests (backend-only remediation 5 did not rerun this unaffected lane);
- production build: frontend, backend, CLI, capture;
- retained packed-installed Pi/Forge/MCP parity: 41 packaged files;
- retained public contract rebuild/stability: contract 20.1.0, 119 public routes; two additive reconciliation GETs and the existing approved override marker;
- exact Express/OpenAPI parity: 84 route files;
- tier lint: 120 public, 56 auth, 17 paid, 89 admin, 176 MCP-exposed tools;
- license headers: 1,410 source files; single Apache-2.0 boundary accepted;
- retained remediation-4 OpenCore preflight: 16 shareable paths, 1 explicitly reviewed migration, 0 blocked, 0 unknown; remediation-5 did not rerun export tooling and makes no new export claim;
- retained frontend ESLint: 0 errors / 56 pre-existing warnings;
- backend ESLint: 0 errors / 43 pre-existing warnings;
- retained backend production audit: 0 vulnerabilities;
- `git diff --check` and staged checks;
- focused staged and exact remediation-5 gitleaks scans: no leaks.

The root production audit still reports the pre-existing React Router advisory `GHSA-qwww-vcr4-c8h2` (2 high findings) and proposes a breaking dependency change. The remediation did not alter frontend routing dependencies and does not claim that repository-wide dependency advisory as fixed. The required backend production audit is clean.

## Coverage truth

`governed-mission-waves-coverage.json` records all 51 criteria individually:

- 44 locally validated implementation criteria;
- 1 blocked independent-rereview criterion (`W1-009.4`);
- 6 blocked external-authority criteria (`W1-010.1`–`W1-010.6`).

No local implementation criterion remains partial. Local validation does not convert independent review or provider evidence into approval.

## Safe next action

Request a fresh independent exact-SHA Wave 1 rereview. Do not touch protected/live runs, contact providers, create remote delivery artifacts, merge, deploy, or begin Wave 2.
