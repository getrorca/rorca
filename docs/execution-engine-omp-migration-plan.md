# Rorca Execution Engine → OMP Migration Plan

**Status:** Proposed · **Owner:** Dimitri / Rorca program · **Date:** 2026-08-07
**Scope:** Replace the pi-direct story executor with OMP as the primary executor; Rorca retains specs, memory, SSDLC, WAL, worktree governance, and pg-boss dispatch. Execute the complete change as one dependency-ordered delivery program from OMP and observe it in Rorca and OMP.

---

## 1. Executive summary

Rorca's current execution path (pi child driven by `execution-engine.ts`) is the weakest link in the platform: it has produced recurring `prompt_delivery_failed` failures across every spec run this session, fragile prompt-delivery protocol checks, and a delivery experience that lags OMP's. OMP has proven stable, self-healing at the session level, and capable of running the same governed work when driven through the existing `OmpManagedExecutor` (W5-007) adapter.

This plan makes **OMP the default story executor** while keeping Rorca as the **control plane** (specs, SSDLC gates, evidence, memory, WAL/Buzz feed, worktree lifecycle) and pg-boss as the **dispatch authority** — unchanged in role. Hermes becomes the **supervisor layer** between them. The work is configuration + integration, not a rewrite: most components already exist.

**Non-goals:** rewriting the SSDLC, replacing pg-boss, dropping the worktree protocol, or removing the pi path entirely (it remains the fallback).

**Execution unit:** one spec — `source-verified-hermes-rorca-omp-ssdlc-delivery-program`.
Its `US` / `HMG` / `AAV` / `MIG` / `INT` stories retain their module ownership but
share a single machine-readable dependency graph. One trigger dispatches all ready
stories in parallel and never launches a consumer before its provider.

---

## 2. Current architecture

```
Operator ──► Rorca UI / CLI / MCP (193 tools)
                 │
                 ▼
            Rorca backend (:3030)
    specs · SSDLC · evidence · memory · WAL/SSE · worktree lifecycle
                 │  enqueue pipeline:run (agentOverride: pi|omp)
                 ▼
            pg-boss (dispatch authority: claim, retry, cancel, DLQ, closeout)
                 │
                 ▼
            worker (single queue consumer, batch semantics)
                 │  spawns
                 ▼
            execution-engine.ts ──► pi child (prompt delivery protocol)
                 │                    (flaky: prompt_delivery_failed,
                 │                     api_key_invalid on retries)
                 ▼
        story_results / manifests / WAL events ──► SSDLC gates
```

Pain points observed this session:
- `prompt_delivery_failed: pi_progress_log_unverified` — recurring, kills HMG-001/AAV-001 in every run.
- Transient `api_key_invalid` on retry attempts (sandbox auth copy).
- Batch serialization forced the `RORCA_WORKER_PARALLEL` + second-worker workaround (now landed and required going forward).
- Worktree staleness chains (stale_base/dirty_worktree) from engine-driven retries.

---

## 3. Target architecture

```
        Operator (Buzz #hermes / Slack)          Operator (Rorca UI / CLI)
                 │   commands, approvals                │
                 ▼                                     ▼
            Hermes (supervisor + orchestrator) ◄──► Rorca control plane
   intent → draft → persist · supervise runs     specs · SSDLC · evidence ·
   watchdog v2 (inter-run healing) · learn loop  memory · WAL → Buzz · worktree
                 │   watch (WAL/SSE)                    │  enqueue pipeline:run
                 ▼                                     ▼
                 └──────────────► pg-boss (unchanged: claim, retry, cancel,
                                                 DLQ, closeout, concurrency)
                                                 │
                                                 ▼
                                            worker ──► OmpManagedExecutor (default)
                                                 │        omp --mode rpc --profile rorca
                                                 │        (subagents, skills, session
                                                 │         self-healing)
                                                 │  fallback: execution-engine.ts ──► pi
                                                 ▼
                                        story_results / manifests / WAL ──► SSDLC gates
                                                 │
                                                 └──► AAV-007 event stream ──► Run View
                                                                        └──► AAV-011 → OMP sessions
```

### Three healing levels (complementary, not overlapping)

| Level | Owner | Scope | Example |
|---|---|---|---|
| Intra-run | OMP | Session-level: model retries, subagent failures, tool errors | subagent II fails → OMP retries/continues |
| Inter-run | Hermes (watchdog v2) | Story/run level: diagnose → alternate model → restart → worktree refresh → gate re-eval | provider exhausted mid-run |
| Final | Operator | Approvals, exceptions, policy | `#hermes` approve/reject |

---

## 4. What changes vs what stays

### Stays exactly the same
- **pg-boss**: dispatch authority, claim/retry/cancel/DLQ/closeout, `queueMaxConcurrent`/`runNowMaxConcurrent` concurrency governor, `RORCA_WORKER_PARALLEL` parallel workers.
- **Rorca control plane**: specs, SSDLC gates, evidence contracts, memory/Genesis, WAL/SSE (feeds Buzz), worktree lifecycle (branch-per-spec, freshness protocol).
- **The pipeline API surface**: trigger/preflight/cancel/retry contracts; `agentOverride` already exists.
- **SSDLC evidence derivation**: `story-result:<id>` → gate evidence; manifests; release intents.
- **Hermes gateway surfaces**: Slack + Buzz gateways, chat-provider abstraction, operator commands.

### Changes
1. **Default executor**: pipeline story dispatch selects `omp` by default; `pi` remains available per-spec/run override (and as watchdog fallback).
2. **OMP child sandbox wiring**: the ordinary-local profile/egress path (currently pi-only) must cover the OMP child on Darwin; on Linux the bwrap path already applies.
3. **Run View**: OMP orchestration tree (I/II/III/IV) replaces/augments the pi ansi-html rendering (AAV-007/008).
4. **OMP → OMP-session feed**: `rorca_subscribe_run_events` pushes live run/gate/evidence events into supervising OMP sessions (AAV-011).
5. **Watchdog home**: v1 lives in the backend; v2 moves to hermes-rorca as the inter-run healing layer (AAV-020), watching via WAL, escalating through the gateways.
6. **Engine fallback insurance**: fix `prompt_delivery_failed` root cause so the pi fallback lane is dependable.

---

## 4a. UI impact — what changes in the Rorca frontend

**Yes, there are UI changes — deliberately scoped to the run surface only.**

### Changes (frontend)
1. **Run View — orchestration tree (NEW, AAV-008)**: for OMP-executed runs, the current ansi-html semantic terminal view is replaced by the durable orchestration tree — parent agent + I/II/III/IV subagent lanes with live status, role, parentage, elapsed time, failure reason, evidence links, retry/continuation lineage. Roman numerals are presentation labels only; stable agent IDs drive identity. Refresh-safe (rebuilt from stored events). Includes WCAG requirements and focused frontend tests (`RunViewPanel`/`RunTerminal`).
2. **Run View — raw OMP terminal tab (NEW, AAV-009)**: optional PTY passthrough of the live omp session for operator fidelity/debugging. The structured tree remains authoritative; bytes bounded, secrets redacted, reconnect explicit.
3. **Run metadata**: the executor label (`omp` vs `pi`) and per-story model/effort render from existing run fields (`agent_model`, effort) — no new schema, minor display work.
4. **Trigger UI — executor selector (SMALL)**: run options gain an executor (agent) picker defaulting to `omp`, backed by the existing `agentOverride` trigger option. Per-spec override field visible on the spec detail page.

### Unchanged (frontend)
- Specs panel, spec detail/review slide-overs, lifecycle/SSDLC surfaces (gates, evidence, traceability, blocker lists), memory/Genesis panels, settings, health/queue dashboards — executor-agnostic, no changes.
- Run View rendering for `pi`-fallback runs — the existing ansi-html/semantic views remain intact and are the fallback presentation.
- Buzz is a separate product (not Rorca UI); its channel feed is driven by the unchanged WAL bridge.
- Hermes operator UI (:8787) — unchanged (watchdog v2 surfaces supervision state later, out of this plan's UI scope).
- Existing frontend tests must stay green; AAV-008/009 add their own focused tests.

---

## 5. The two-way bridge

```text
OMP session ──MCP tools (rorca_*)──▶ create spec, trigger run (agent: omp), query gates
OMP executor ──story events──▶ Rorca records ──▶ Run View (status IN Rorca)
Rorca WAL ──AAV-011──▶ live events pushed INTO the OMP session (status IN OMP)
```

- **OMP → Rorca**: already live (193-tool MCP surface; `rorca_record_subagent_run`, `rorca_select_workspace`, pipeline/specs tools). This session is the reference implementation.
- **Rorca → OMP**: AAV-011 subscribes to the canonical WAL/SSE envelope with idempotent replay and workspace isolation; AAV-007 supplies `orchestration.*` payloads and HMG-010 supplies `gateway.*` payloads.

## 5a. Trade-offs — agent-type coverage

OMP covers most execution lanes natively (openai-codex, deepseek via its provider catalog);
**the claude sub is the notable gap** — OMP has no anthropic provider/auth in its catalog and
no native Claude Code subagent (the I/II/III/IV lanes are OMP-runtime sessions).

Mitigations:
- **Localize, don't lose**: the story manifest declares `agent` per story; heterogeneous waves
  already run mixed agent types. Stories needing Claude Code keep `agent: claude` (Rorca's
  claude lane, with its loop) alongside OMP-default stories in the same run.
- **Exotic providers**: opencode's 75+ providers are covered only where OMP's catalog has an
  entry; missing providers need catalog additions or a Rorca agent override.
- **Claude models work with zero platform infrastructure**: OMP's adapter is
  `openai-completions`-based, so any OpenAI-compatible endpoint the USER already has gives
  OMP claude models with the same adapter — `baseUrl` + API key, no catalog fork. Simplest
  paths: a direct Anthropic API key against Anthropic's OpenAI-compatible endpoint, or the
  user's existing OpenRouter key. Rorca/Hermes host no proxy and none is implied; a
  platform-configured route is strictly optional. Users who need Claude models are covered by
  default; the Rorca `claude` lane remains only for the narrow case of wanting Claude Code's
  exact agentic behavior (its CLI tool loop), still available per-story via `agent: claude`.
- **Shell-tool claude invocation inside OMP works but is NOT a governed subagent** (no lane,
  no OMP supervision) — the Rorca `claude` agent type is the governed path.
- **Why keep the engine at all**: no lasting execution advantage over OMP. Its residual roles
  are (1) the claude Code lane, (2) the fallback path, (3) maturity reference. Governance
  (evidence, WAL, waves, manifests, worktrees, sandboxing) belongs to the control plane and
  stays regardless. Its signature delivery protocol is today a bug source, not a strength.

---

## 6. Work breakdown

### Phase 0 — Prerequisites (foundation)
- [ ] Fix `prompt_delivery_failed` root cause (progress-log verification) so the pi fallback lane is reliable. *(Insurance; the OMP lane doesn't use the pi protocol.)*
- [ ] Wire the OMP child through the ordinary-local sandbox profile on Darwin (egress broker, auth copy, runtime state) — the OmpManagedExecutor currently inherits the pi launch machinery; verify/complete the OMP-specific path.
- [ ] Validate OMP executor against one full story on this host (fake-omp → real omp), including NIP-42-less local posture.

### Phase 1 — Default flip (config, no rewrite)
- [ ] Pipeline default `agent` selection: `omp` unless overridden (spec field, trigger option, per-run).
- [ ] Per-spec override support (`agent: omp|pi` in spec JSON; the trigger already reads `story.agent`-style overrides — confirm the spec-level field).
- [ ] Watchdog/retry preserves the run's executor (already modeled: restarts carry the original agent).
- [ ] Regression: existing pi-driven specs still run via override.

### Phase 2 — OMP visibility in Rorca (AAV-007/008)
- [ ] AAV-007: OMP JSONL RPC → provider-neutral OrchestrationEvent stream (monotonic seq, idempotent, parentage, run/story/attempt binding; vocabulary frozen from a live omp run).
- [ ] AAV-008: Run View orchestration tree (I/II/III/IV as presentation labels; stable agent IDs; refresh-safe reconstruction; WCAG).
- [ ] AAV-009: raw OMP terminal tab (PTY, bounded, redacted) — debug surface.

### Phase 3 — Canonical event feed and Hermes skill
- [ ] AAV-007 emits versioned `orchestration.*` payloads; HMG-010 emits versioned `gateway.*` payloads; both travel on the existing WAL/SSE envelope.
- [ ] AAV-011 exposes `rorca_subscribe_run_events` with replay and workspace isolation; HMG-010 is the sole owner of the Hermes workflow skill and verifies exact implemented tool names.

### Phase 4 — Hermes supervision and executor-neutral fallback
- [ ] Watchdog v2 in hermes-rorca consumes canonical events and invokes only governed Rorca action/receipt paths; it never becomes a second scheduler.
- [ ] AAV-021 resolves the named alternate policy in Rorca and records evidence; OMP performs intra-session fallback and Pi consumes the same policy only when explicitly selected.
- [ ] AAV-022 adapts heal outcomes to the sole US-007 candidate store.

### Phase 5 — Component qualification, cross-spec qualification, and rollback
- [ ] MIG-005 qualifies executor parity and rollback; AAV-010 qualifies assurance/OMP component parity.
- [ ] INT-001 registers every provider/consumer contract and executes consumer-driven checks against real artifacts.
- [ ] INT-002 proves the full source → persist → controls → assurance → OMP → evidence → gate → supervision → learning chain; INT-003 verifies the executor/recovery matrix.
- [ ] Rollback runbook selects Pi explicitly once after fallback qualification and verifies no executor-contract drift.

---

## 7. Contract amendments and execution packaging

The canonical ownership boundary is [`contracts/ssdlc-interoperability.md`](contracts/ssdlc-interoperability.md). These are module boundaries inside one executable program, not separately-triggered specs:

| Story module | Amendment |
|---|---|
| US | Sole owner of the ControlRecord/catalog, applicability, phase groups, seven-stage readiness projection, canonical evidence evaluation, structured findings, and the single learn candidate store |
| HMG | Sole owner of source/intent contracts, gateway events, and the Hermes workflow skill; persist now compiles controls and assurance before approval; drift invalidates profile/revision |
| AAV | Consumes the universal catalog; binds mechanisms rather than selecting controls; normalizes kernel outcomes to canonical lifecycle evidence; consumes both event families; adapts outcomes to US-007 |
| MIG | Owns executor sandbox/default/parallelism/parity only; Pi fallback is explicit; gate and UI semantics stay with US/AAV |
| INT | Adds contract registry, full-chain scenario, and executor/recovery matrix as the release proof |
| Delivery program | One trigger schedules all module stories by the shared DAG; it replaces independently running five component drafts |

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| OMP child sandbox posture on Darwin fails closed | Phase 0 explicitly wires the ordinary-local profile for OMP; Linux bwrap path unchanged |
| OMP RPC event vocabulary differs from assumptions | AAV-007 acceptance criterion: freeze vocabulary from a live instrumented run before schema work |
| Long OMP sessions + batch queue semantics serialize runs | Already mitigated: `RORCA_WORKER_PARALLEL` + second worker (live); concurrency settings remain the governor |
| Watchdog relocation introduces a gap | v1 stays operational until v2 lands; both write the same WAL healing contract |
| Provider/model policy drift | AAV-021 policy layer lives in Rorca (single source of truth); OMP only executes the resolved chain |
| Worktree staleness from OMP-driven runs | Worktree lifecycle unchanged (Rorca-owned); the freshness protocol is executor-agnostic |
| Buzz/Slack gateway load from high event volume | Bridge + gateways are bounded/redacted; AAV-011 subscriptions are workspace-scoped with replay |

---

## 9. Rollback strategy

- **Default flip** is a single dispatch configuration change only after MIG-005 confirms executor-contract compatibility; Pi remains an explicit override.
- **OMP visibility** (AAV-007/008/009) is additive — old ansi-html rendering remains available for Pi fallback.
- **Supervisor feed** (AAV-011) is additive on the canonical WAL/SSE envelope; sessions without a subscription are unaffected.
- **Watchdog v2** consumes governed action/receipt paths; v1 can remain active until v2 qualification completes.
- Executor contract compatibility is verified by MIG-005 and INT-003; assurance/gate semantics are verified by AAV-010 and INT-002.

---

## 9a. Wave-parallel execution (unchanged, but must be verified)

Wave-parallel orchestration **stays exactly where it is** — it is Rorca-side orchestration,
not execution, and is executor-agnostic:

- **Wave scheduler** (story→wave compilation, wave-production-policy gating, maxWaveSize,
  parallelism) — unchanged.
- **Per-story worktrees + branches** (story-worktree-lifecycle: one worktree per story in a
  concurrent wave) — unchanged; the isolation protocol is the same for any executor.
- **Merge-back** (commitGuardedMerge of per-story branches to the run branch) — unchanged.
- **Executor per story — generic across ALL CLI agents**: wave-parallel is not pi-specific.
  The wave scheduler spawns the per-story process for whatever agent type the story manifest
  declares — claude, opencode, codex, pi, and now omp — each in its own story worktree, all
  wrapped by the same parallel-launch and merge-back machinery. Heterogeneous waves (different
  agent types across stories in one run) are supported by the per-story manifest already.
  For OMP specifically: a wave of N parallel stories = N concurrent OMP RPC sessions, each in
  its own story worktree. The W5-007 managed-executor admission already enforces the wave model
  (`parallelism = 1`, `branchOnly = true`, `autoMerge = false` per request) — it was designed as
  the per-story worker inside the wave.
- **Failure semantics**: OMP heals intra-story (session level); wave-level decisions (fail wave,
  continue, retry) remain Rorca's wave-policy responsibility — same three-level split as §3.
- **Run View**: wave-parallel adds story lanes in parallel alongside the per-story orchestration
  trees (AAV-008 event stream already carries run/story identity; wave dimension is an
  extension, not a redesign).
- **Qualification**: MIG-005 verifies wave-parallel executor parity and INT-003 verifies it in the executor/recovery matrix; AAV-010 remains the Run View/assurance component qualifier.
- **Resources**: N concurrent OMP sessions per wave × M concurrent runs per worker set — the
  queue concurrency governor (`queueMaxConcurrent`/`runNowMaxConcurrent` + `RORCA_WORKER_PARALLEL`)
  is what bounds it; monitor host load in qualification.

---

## 9b. Watching Rorca runs in the OMP app

Every Rorca-executed OMP story session is **mirrored host-side into the
operator's OMP store**, so runs that happen inside Rorca's sandboxed per-run
runtime dirs (which are deleted at run end) still surface in the operator's
OMP app for replay or continuation.

- **Where the mirror lives**: `~/.omp/profiles/rorca/agent/sessions/<cwd-namespace>/<timestamp>_<sessionId>.jsonl`
  — the same directory layout and `<ISO-8601>_<id>.jsonl` file naming that OMP
  17.x `SessionManager` uses, in the `rorca` profile's agent dir. The store
  (`backend/src/lib/omp-session-store.ts`) writes omp's standard
  `{"type":"session","version":3,...}` header entry first so OMP listings and
  `--resume` discover the file, then tees every JSONL event of the run stream
  verbatim (a pure tee — Rorca never rewrites or withholds events). Files are
  operator-private (`0600`), and the tee refuses to write through symlinks.
- **Replay / continue any story session**:
  ```bash
  omp --profile rorca --resume                 # picker over archived story sessions
  omp --profile rorca --resume <id-prefix>     # replay/continue a specific session
  omp --profile rorca --export <session-file>  # export an archived session to HTML
  ```
  `--resume` reads the same store Rorca writes, so an archived Rorca-run
  session can be continued exactly like a session started inside the OMP app
  itself. `--session-dir` also works for pointing at a specific store.
- **Operator-store override**: set `RORCA_OMP_SESSION_STORE_ROOT` to relocate
  the sessions root (tests, tooling, or host-side store relocation). Unset, the
  root defaults to `<operator-home>/.omp/profiles/rorca/agent/sessions` —
  resolved from the passwd entry, never a redirected `$HOME`, so the durable
  mirror always survives the ephemeral per-run sandbox home.
- **Verification**: `backend/src/lib/__tests__/omp-session-store.node.test.ts`
  runs a bounded real `omp --mode rpc --profile rorca` session and proves the
  tee file is written with session events and survives process teardown
  (`npm run verify:omp-session-visibility`).

---

## 10. Done definition

- [ ] Contract ownership and Consumer-Driven Contract checks pass via INT-001
- [ ] Universal Controls compiles 11 phase groups into seven Mission stages; maintenance is non-blocking
- [ ] Default executor is OMP; Pi runs only via explicit override
- [ ] OMP sandbox wiring verified on Darwin and Linux
- [ ] `prompt_delivery_failed` fixed; Pi fallback lane green
- [ ] AAV-007/008/011/020/021/022 land per their amended acceptance criteria
- [ ] HMG source bundle → exact revision → controls → assurance profile is verified, including drift invalidation
- [ ] MIG-005 and AAV-010 component qualifications pass
- [ ] INT-002 full-chain and INT-003 executor/recovery qualifications pass with exact receipts
- [ ] Buzz channels stream lifecycle events; rollback runbook executes once under staging-equivalent conditions

---

## 11. Effort estimate

| Phase | Effort | Parallelizable |
|---|---|---|
| 0 — Prerequisites | 2–3 days | with Phase 1 |
| 1 — Default flip | 0.5–1 day | — |
| 2 — OMP visibility | 3–5 days (AAV-007/008/009) | yes |
| 3 — Supervisor feed | 2–3 days (AAV-011) | with Phase 2 |
| 4 — Hermes supervision | 4–6 days (AAV-020/021/022) | yes |
| 5 — Qualification | 2–3 days | — |
| **Total** | **~2–3 weeks** | |

---

## 12. Summary

The change is **configuration + integration, not a rewrite**: flip the executor default, wire the OMP child through the existing sandbox, land the AAV visibility/supervision stories, and move the watchdog into Hermes. pg-boss, SSDLC, evidence, WAL/Buzz, and worktree governance are untouched. The two-way bridge is the product: **run specs in OMP, see status in Rorca, supervise from Buzz.**
