# Deterministic wave stress, soak, and leak qualification

This qualification is a provider-free, seeded model gate layered on the real
fixture-agent and isolation gates described in [README.md](./README.md). It is
not an application benchmark and never falls back to a normal `DATABASE_URL`.

## Profiles

| Profile | Command | Minimum matrix | Hard child deadline | Blocking |
| --- | --- | --- | --- | --- |
| CI | `npm run qualify:wave:ci` | 3 seeds × every versioned scenario × parallelism 2 and 4; 32 generated property schedules; 2 leak repeats | 60 seconds | Yes, first attempt only |
| Soak | `npm run qualify:wave:soak` | 100 seeds × every scenario × both parallelisms; 100+ generated schedules; 5 leak repeats | 14 minutes | Operator-invoked only |
| Diagnostic | `npm run qualify:wave:diagnostic -- --seed=<seed> --scenario=<id> --parallelism=<2-or-4>` | Reports a separate investigation run | 60 seconds | No; never replaces CI |

The soak command is deliberately absent from ordinary lint, typecheck, build,
and unit-test scripts. `test:wave-qualification` invokes the CI profile after
the process/Git fixture gates. The launcher contains no retry loop. A failed
first attempt remains authoritative even if an operator later runs the exact
diagnostic command from its failure report.

## Matrix and model oracle

`wave-qualification-model.ts` defines allowed transitions independently for:

- story;
- attempt;
- integration;
- wave; and
- run.

The matrix covers success, forward/reverse/generated completion orders,
rejection before and after commit, dirty rejection, an already-running sibling,
dependency chains, integration conflict, cancellation, timeout, all nine durable
crash boundaries (`WPE-FP-001` through `WPE-FP-009`), duplicate queue delivery,
restart, and explicit story retry. Every generated transition is replayed from
the initial reference state. The observed source, destination, sequence, and
terminal projection must agree with the model.

For a given seed, scenario, and parallelism, the source-tree digest, canonical
commit topology, accepted stories, blocked dependencies, semantic closeout,
recovery references, and normalized event trace are byte-for-byte stable.
Completion-order scenarios additionally prove that canonical terminal source
and accepted topology do not depend on arrival order or the bound (2 versus 4).

The mutation gate deliberately corrupts five safety properties and requires the
oracle to reject each corruption: pass-before-integration, absent dependency
blocking, duplicate finalization, false successful closeout, and unsafe cleanup.

## Resource and database sentinels

Every iteration samples baseline, peak, and final inventories for process count,
file descriptors, child processes, worktrees, temporary refs, successful
temporary branches, queue jobs, leases, test rows, open Git operations, and
artifacts. Owned transient resources must finish at zero; process and descriptor
counts may not increase over that iteration's baseline. Repeated runs fail on
monotonic growth, rather than hiding it with a broad tolerance.

Migration `20260719102000_wave_stress_qualification.sql` records one exact
`qrun_<24 hex>` namespace and ownership proofs for every created workspace,
spec, run, story result, WAL event, lease, integration record, and opaque queue
job ID. The assertion function requires all eight resource kinds. Queue tables
remain pg-boss-managed. Protected production records are represented only by
before/after SHA-256 sentinels, constrained to equality; qualification does not
store their values or paths.

## Performance policy

The checked metrics are dispatch latency, merge/closeout latency, peak memory,
peak disk, process count, output backlog, queue lag, lease renewal, and cleanup
time. [`wave-stress-baseline-v1.json`](./wave-stress-baseline-v1.json) is the
versioned baseline. Each observation must be at or below both:

1. the explicit absolute cap; and
2. `baseline × baselineMultiplier`.

This makes failures interpretable and prevents undocumented local machine timing
from becoming the threshold. Baseline changes require a new version and review;
they must not be rewritten to bless a failing run.

## Portable reports and receipts

Every stress invocation runs `build-wave-qualification-evidence.ts` as a separate blocking phase and writes canonical JSON, deterministic Markdown, and a strict authenticated receipt under the owned `.rorca/qualification/<digest>/` namespace. The builder receives only normalized status and seeded model inputs, never captured terminal output. Report generation, signing, telemetry, or publication failure fails the launcher.

The provider-free stress profile cannot by itself provide durable database/WAL, Git integration, or independent-checker proof, so its receipt accurately leaves production enable unavailable. The complete production qualification must attach those authoritative classes and pass local receipt verification described in [`wave-parallel-v1/qualification.md`](./wave-parallel-v1/qualification.md).

## Failure evidence

On failure the launcher preserves a mode-0600 JSON report under the explicitly
owned `.rorca/qualification-failures/<digest>/` recovery area. It emits the seed,
scenario, fault-point ID, normalized failure event, safe recovery references,
resource samples, and exact diagnostic rerun command. It does not persist child
stdout/stderr, credentials, database URLs, repository paths, or production
identities. Output capture itself is bounded to 256 KiB and overflow is failure.
