# Wave 5 Plan — Forgejo Adapter + Oh My Pi (omp) Primary Shim

> Status: PLAN (v1) — grounded in the merged program tree at HEAD `589da3189`
> (waves 2–4 accepted; W4-014 clean-room certified; W4-010 pre-credential demo complete).
> Owner: autonomous wave program parent (this session). Commits: parent-only.

## 1. Vision and goals

Three coupled deliverables, in priority order:

1. **Forgejo adapter for rorca/hermes** — mirror the GitHub adapter machinery
   (`check-run-poster`, `release-authority`, `github-app-credential-provider`,
   `github-token-resolver`, `routes/webhooks.ts`) with Forgejo-native API and
   auth, and **bridge the Wave-4 federation result proposal to Forgejo draft PR
   + commit-status projection at the exact head** (the W4-010 residual step,
   re-targeted from GitHub to the operator's own Forgejo server).
2. **Oh My Pi (omp) as the primary execution shim** — replace the `pi` CLI as
   the rorca/hermes runtime: `OmpManagedExecutor` alongside `RorcaManagedExecutor`,
   wire the already-built `PiManagedContinuationController` into production,
   keep the rorca extension/skills working under omp, and let omp interact with
   rorca/hermes (and hermes drive spec execution through omp).
3. **Spec generated through rorca machinery, wave run here** — author the Wave-5
   spec through `/api/specs` (generate → preflight → persist → lifecycle/compile
   → approve), leverage the Genesis knowledge bridge + the rorca skills suite
   (match-skills / suggest-models) in the spec loop, then execute the wave in
   this environment.

## 2. Grounded findings (scout-verified, exact anchors)

### 2.1 GitHub adapter surface (the mirror template)

- `backend/src/lib/check-run-poster.ts` — durable Check Run projector: WAL
  (`run_started`/`run_finished`) subscription + 30 s reconcile; check name
  `Rorca Pipeline`, `external_id rorca:pipeline-run:{runId}:v1`; authority
  frozen from `pipeline_run_release_intents`; provider calls
  `GET /commits/{sha}/check-runs`, `POST /check-runs`, `PATCH /check-runs/{id}`.
- `backend/src/lib/release-authority.ts` — THE real draft-PR actuator:
  `RunMergeStrategy 'direct'|'pr'|'draft-pr'|'branch-only'`,
  `prepareRunReleaseIntent`, `POST /pulls` with `[WIP] {specId}` + draft flag,
  `assertCanonicalPullRequest`, `quarantinePullRequest`, reconcile/drain.
- `backend/src/lib/release-identity.ts` — locks + identity revalidation
  (`withGithubRepositoryAuthorityLock`, `withRunReleaseLock`,
  `revalidateRunReleaseIdentity`, `withGithubReleaseActuation(exact, purpose, …)`).
- `backend/src/lib/github-app-credential-provider.ts` — JWT (RS256, 9 min) →
  installation token with **exact permission profile** assertions
  (`GITHUB_APP_REQUIRED_PERMISSIONS`, `GITHUB_APP_REQUIRED_EVENTS`), token
  cache, invalid-marking, workspace binding rows.
- `backend/src/lib/github-token-resolver.ts` — purpose-scoped token resolver.
- `backend/src/routes/webhooks.ts` — HMAC + App identity verification,
  generic `WebhookRouter`.
- **Wave 4 federation terminates at closeout — nothing bridges federation
  results to PR/Check today.** The Forgejo program adds that trigger through
  the release-authority/check-run-poster patterns.
- No Forgejo/Gitea adapter exists anywhere; only `local_fake_forgejo` fake
  provider kind (W4-013, `lib/governed-resource-inventory.ts`).
- `docs/forgejo-private-vps-handoff.md` + `docs/governed-hermes-operations.md`
  exist (sibling infrastructure docs).

### 2.2 Spec pipeline (how a wave spec is made "through rorca")

- Tier 1 authoring: plain-JSON wave specs in `forge/specs/pending/`
  (`wave-4-bounded-federated-runtime-pilot.json`: 2155 lines, 14 stories,
  92 criteria; top-level `id/slug/title/generatedAt/model/autoWorktree/
  userStories[]` with `{id,title,description,acceptanceCriteria[],dependsOn[],
  passes,suggestedSkills[]}` + appended authoring block with
  `parentAuthoringPlan`, `lifecycleCompiler`, `executionAuthority`).
- Router `/api/specs`: `POST /generate` (GenerateSpecSchema: workspaceId,
  brief/specBrief, model, storyCount) — **drafts carry optional
  `GenesisProvenanceSchema {packageId, packageHash, contentHash}`** (the
  genesis bridge is built in); then `POST /forge` (skill-first),
  `/authoring/preflight`, `/authoring/preflight/confirm`, `/persist`,
  `/:specId/lifecycle/compile`, `/:specId/approve`, `/:specId/validate`,
  `/:specId/match-skills`, `/:specId/suggest-models`, `/:specId/import/*`.
- Tier 2 governed execution: approved spec → `rorca.mission-contract.v1`
  (MissionContractV1Schema) → `POST /api/mission-control/v1/missions/compile`
  (requires exact append-only authority snapshots) → work package revision.
- Wave gating: exact-SHA packet verifiers (`wave4-federation-gate.ts`
  pattern) binding reviewed SHAs + receipt hashes.

### 2.3 pi CLI shim + omp surface (the replacement contract)

- pi CLI contract today: `pi --mode rpc` (JSONL-RPC over stdio, ≥0.80.4,
  profile rpc-jsonl-v1) and `pi --mode text` via node-pty fallback.
- Execution engine spawns pi via `spawnPiRpc` (`execution-engine.ts` 643–645,
  2289–2292, 3091–3092) with `--json <spec> --cwd <worktree> --run-id
  --workspace-id --story <id> --parallelism 1 --agent … [--model] …`.
- ROR-28 `RorcaManagedExecutor` (`lib/rorca-managed-executor.ts`) wraps the
  **engine** via `CurrentEngineManagedBridge` (IPC handshake, fence tokens,
  hashed output evidence, capability-snapshot admission); worker constructs
  per-workspace executors at `worker.ts:4325-4343`.
- `PiManagedContinuationController` + `NormativeContinuationLane` are
  **defined and fully test-covered but NOT wired into production** — the
  ready-to-hook design surface for this wave.
- **omp v17.0.9 CLI** (verified on this machine): `--mode text|json|rpc|rpc-ui`,
  `-p/--print` (non-interactive), `--cwd`, `--model` (fuzzy/canonical),
  `--smol/--slow/--plan` role flags, `--thinking off|minimal|low|medium|high|
  xhigh|max`, `--profile`, `--extension/-e`, `--hook`, `--no-pty`,
  `--max-time`, `--auto-approve`, positional messages (`@file` prefix). The
  `pi --mode rpc` contract carries over natively.
- omp loads legacy pi extension modules natively (`loadLegacyPiModule`:
  rewrites `@mariozechner/*`, `@earendil-works/*`, `@sinclair/typebox` onto
  host copies; `pkg.omp` manifest preferred, `pkg.pi` accepted). The rorca
  extension **already loads in omp** (`~/.omp/agent/config.yml` →
  `~/rorca/packages/rorca-pi-extension/extensions/rorca/index.ts`).
- rorca-pi-extension (main, v0.2.0): extensions/rorca + skills
  (rorca-forge, rorca-forge-run, rorca-retry-planner, rorca-run-operator,
  rorca-approve). Worktree version v0.3.0 adds the Hermes autonomous
  supervisor + new `@rorca/capture` package (absent from main).
- **Main-only omp references** (not on the wave branch): `backend/src/lib/
  mcp-http.ts` `rorca_record_subagent_run` / `rorca_select_workspace` tools
  with `omp-subagent:<agent>` provenance — port onto the wave branch.
- **User-owned branch `feat/dms-omp-adapter-20260804` on main** (103 files,
  +29 680): pi Durable Mission Supervisor (`.pi-supervisor/` autopilot
  archives), DMS canary scripts, omp-adapter compatibility tests. USER WORK —
  the wave reconciles with it (read + cherry-pick compatible pieces with the
  user's blessing), never merges blindly.
- Hermes = external governed service principal (`rorca-hermes-service`,
  `X-Rorca-Service: hermes`, Bearer `RORCA_INTERNAL_SERVICE_TOKEN`): legacy
  TaskManifest bridge + strict campaign trigger
  (`hermes.campaign-dispatch-authorization.v1`, `POST /api/pipeline/trigger`).
- Story launch → `boss.send('pipeline:run')` → worker `handlePipelineRun`
  → engine child (agents claude/opencode/codex/pi; `--story <id>` bridge).

### 2.4 Harness (how the wave runs + gates here)

- Gate: `cd backend && npm test` = complete 8-shard hermetic gate
  (`scripts/run-isolated-jest.ts` + `complete-jest-orchestrator.ts`,
  `--shard=i/8 --maxWorkers=1`); focused: `npm test -- <paths>`.
- Compose smoke: `scripts/wave2-compose-empty-volume-smoke.sh` (wave-3/4
  receipts reuse it verbatim); wave-4 harnesses: `scripts/wave4-pilot-demo.ts`,
  `scripts/wave4-cleanroom-realhost-cert.ts`.
- Frontend: Run View `/runs/:runId` (+RunActivityView); `npm run dev:full`
  (frontend :5210, backend :3030, worker).
- Demo stack recipe: self-provisioning compose (fresh PG16.14, 282
  migrations, split principals, `RORCA_FEDERATED_CREDENTIAL_PEPPER`,
  `RORCA_TRUSTED_PROXY_IPS`) — proven by the W4-010 demo runner.

### 2.5 Forgejo server status

- **No Forgejo host discoverable on this machine** (no ssh config entry, no
  known_hosts entry, no env, no git remote; rorca `origin` is GitHub
  `getrorca/rorca`). Instance URL, repository, and a scoped token are
  **operator prerequisites** — same class as the GitHub App credentials.
- Forgejo API is Gitea-compatible: draft PRs (`POST /repos/{owner}/{repo}/
  pulls` with `draft: true`), commit statuses (`POST /repos/{owner}/{repo}/
  statuses/{sha}`), webhooks (`X-Forgejo-Signature` / `X-Gitea-Signature`
  HMAC-SHA256). No GitHub-App-equivalent installation model → token-based
  auth with exact-scope probing. Forgejo Actions check runs are a separate
  surface — spike against the live server (operator-gated).

## 3. Architecture decisions

### 3.1 Forgejo adapter (stories W5-002…W5-006)

Mirror the GitHub surface 1:1 in shape, Forgejo-native in transport:

- `forgejo-token-credential-provider.ts` — repo-scoped token (or OAuth2 app
  client flow if the operator prefers), **exact capability probe** instead of
  GitHub's JWT permission assertion: `GET /user`, `GET /repos/{owner}/{repo}`,
  and a deny-on-unknown probe policy; digest-only persistence, raw token never
  in DB/logs (reuse wave-2/4 redaction receipts), per-workspace binding rows,
  invalid-marking + reconciliation.
- `forgejo-release-authority.ts` — mirror of `release-authority.ts`:
  `POST /pulls` (draft:true, `[WIP] {specId}`), release intents, reconcile,
  quarantine; all real provider effects host-owned.
- `forgejo-check-poster.ts` — mirror of `check-run-poster.ts` over commit
  statuses (`context: rorca/pipeline`, pending/success/failure,
  `target_url` to the run view) with the same WAL + reconcile discipline;
  Forgejo Actions check-run API as an optional second backend behind the same
  projection interface.
- `forgejo-webhook-router.ts` — HMAC verification (both signature headers),
  events: `pull_request`, `push`, `status`; exact-path mounting mirroring
  the reviewed webhook overlay.
- Federation bridge (W5-005): the W4 `result_proposal` (host-verified, head
  exact) → `prepareRunReleaseIntent` → Forgejo draft PR + status at the exact
  head — **closing W4-010's residual for Forgejo**. `closeoutAuthority`
  stays `none`; the projection is evidence, not authority.
- Hermetic fake: `local_fake_forgejo` upgraded from provider-kind to a
  gitea-compatible in-process/container test server so all gates run without
  the operator's instance.

### 3.2 OMP shim (stories W5-007…W5-009)

- `OmpManagedExecutor` — same `ExecutionAdapter` interface as
  `RorcaManagedExecutor`; launches `omp` with the translated contract:
  `omp --mode rpc --profile rorca --cwd <worktree> --model <resolved>
  --thinking <level> --max-time … @<spec-message>` (positional message =
  the story payload; `--mode text` + `-p/--print` + `--no-pty` fallback).
  Env sanitization mirrors `ENGINE_ENV_REMOVE` + adds omp-specific remove
  list; capability-snapshot admission reuses ROR-28 machinery unchanged.
- Wire `PiManagedContinuationController` + `NormativeContinuationLane` into
  production (worker/service/routes) with an OMP lane adapter — the wave-3A
  design surface becomes live.
- Execution engine: add `omp` to the agent kinds (beside
  claude/opencode/codex/pi); `spawnPiRpc` gains an omp transport; `PI_BIN`
  resolution generalized to `AGENT_BIN` with per-agent kinds.
- Extension/skills compatibility: rorca-pi-extension gains `omp.extensions`
  + `omp.skills` manifest keys; verify all five rorca skills load under omp;
  port the main-only `mcp-http.ts` omp tools (`rorca_record_subagent_run`,
  `rorca_select_workspace`, `omp-subagent:<agent>` provenance) onto the wave
  branch.
- Reconcile `feat/dms-omp-adapter-20260804` (user work): inventory its DMS
  supervisor + canaries in the 5B lane, port compatible parts, flag conflicts
  for the user instead of resolving silently.

### 3.3 Spec + Genesis/skills loop (this wave's meta-goal)

- Generate the Wave-5 spec **through rorca**: fresh compose stack →
  `POST /api/specs/generate` (brief = this plan; model = resolved default;
  genesis provenance attached from captured evidence) → preflight → persist →
  lifecycle/compile → approve (operator-human approval per spec semantics).
- Use the skills suite: `match-skills`/`suggest-skills` bind the five rorca
  skills + genesis knowledge (capture plan/spec as pending candidates,
  search wave-2/3/4 receipts during authoring) — the "same suite as genesis,
  gap bridged" loop: **genesis evidence informs the spec; rorca skills
  execute it; results return to genesis.**
- Story `W5-001` gates the wave on exact prior SHAs/receipts (wave-2/3/4
  heads + clean-room cert hashes + W4-010 demo packet hash), mirroring W4-001.

## 4. Wave program structure and multi-agent model

### 4.1 Lanes (worktrees from the program branch)

- **5A — Forgejo adapter core**: W5-001 gate + W5-002…W5-006
  (`Wave5ForgejoImplementer`).
- **5B — OMP shim**: W5-007…W5-009 (`Wave5OmpImplementer`; includes the
  dms-omp-adapter reconciliation pass).
- **Integration gap closer**: merge 5A/5B into
  `rorca-wave5-integration-<date>`, close shared-contract/drift/wire gaps
  (`Wave5IntegrationGapCloser`).
- **W5-010 — operator lane**: real-server conformance + clean-room
  certification + pilot demo on the operator's Forgejo (parent-owned, like
  W4-010/W4-014).
- Reviewers (independent, exact-SHA): `Wave5SecurityReview`,
  `Wave5ReleaseReview`, then finals; clean-room chain `Wave5CleanRoomReview*`.

### 4.2 Model matrix (per user directive: best model per job)

| Role / subagent job | Model (selector) | Thinking | Rationale |
|---|---|---|---|
| Scouts (read-only exploration) | `deepseek/deepseek-v4-flash` | `:low` | Fast/cheap; breadth over depth |
| Spec generation (via `/api/specs/generate`) | default resolved (deepseek-v4-flash) | `high` | Spec quality > speed; genesis-informed |
| Implementer lanes (5A/5B) | `deepseek/deepseek-v4-flash` | `:high` | Strong local reasoning; token-budget capped (operator directive: no xhigh for coding) |
| Integration gap closer | `deepseek/deepseek-v4-flash` | `:high` | Cross-lane reasoning, same cap |
| Security reviewer | `openai-codex/gpt-5.6-sol` | `:high` | **Alternate provider for independence** (fallback: deepseek `:high`) |
| Release reviewer | `openai-codex/gpt-5.6-sol` | `:high` | Alternate provider; merge/production lens |
| Clean-room cert operator | `deepseek/deepseek-v4-flash` | `:minimal` (mechanical script run) + `:high` review pass | Deterministic script; review pass reasons |
| Genesis capture/curation | `deepseek/deepseek-v4-flash` | `:low` | Mechanical |
| Commit/title | omp `@tiny` role | — | Built-in lightweight role |

Enforced via per-spawn `model:` overrides; exact availability checked with
`omp models` at spawn time; fallback chain
`deepseek/deepseek-v4-flash:max → openai-codex/gpt-5.6-sol` (from
`~/.omp/agent/config.yml`). Reviewers deliberately use a different provider
than implementers to avoid same-model blind spots.

**Token budget (operator directive, 2026-08-06):** no coding work above
`:high`; `gpt-5.6-sol` is never used above `:high` and only for reviewer
roles; implementers stay on `deepseek/deepseek-v4-flash:high` (fallback
`gpt-5.6-sol:high` only when deepseek is unavailable).

### 4.3 Process invariants (unchanged from waves 2–4)

Subagents never commit; parent gates/commits; reviews bind exact SHAs;
post-review additions doc-only with proven deltas; gates serialized with
`DB_GATE_FREE`; `/tmp/clear-stale-jest-state.sh` before wrapper DB runs;
backend gates under arm64 node v22.19.0; root/frontend node v22.22.0; compose
project name `^rorca-wave2-[a-z0-9][a-z0-9_-]{5,80}$`; secrets via
`openssl rand -hex 24`; fail-closed authority; redaction never leaks.

### 4.4 Gate/demo battery for wave 5

1. Focused lane tests (each lane's stories; e.g. Forgejo adapter + fake
   server suite, omp executor suite + continuation-controller wiring tests).
2. Full backend 8-shard gate (`cd backend && npm test`) + frontend Vitest +
   audits 0/0 + drift + gitleaks.
3. Compose smoke (verbatim wave-2 harness).
4. Federation→Forgejo projection demo (fake server, hermetic) then real-server
   conformance on the operator's instance (W5-010).
5. Clean-room real-host certification (mirror `wave4-cleanroom-realhost-cert.ts`).
6. Independent security/release reviews at exact SHA; final acceptance ledger.

## 5. Execution phases

1. **Plan** (this doc) — commit to program branch.
2. **Spec through rorca** — author via `/api/specs` against a fresh stack
   (generate → preflight → persist → compile → approve); commit spec to
   `forge/specs/approved/`; genesis-capture the evidence.
3. **Wave run here** — lanes 5A/5B in parallel (≤4 agents), gap closer,
   review chain, gates, ledger — mirroring waves 3/4 execution in this
   environment, with the omp shim exercised as the executor where possible.
4. **Operator lane (W5-010)** — needs: Forgejo instance URL + repo + scoped
   token → real-server conformance, clean-room certification, pilot demo
   (draft PR + status at exact head), final ledger.

## 6. Operator prerequisites

1. Forgejo instance URL + repository (target of the adapter demo).
2. Repository-scoped Forgejo token (or OAuth2 app credentials) with the
   minimal scope the adapter requires; raw value entered via the local
   operator surface only (never in compose/DB/logs).
3. (Optional) mirror remote `git remote add forgejo <url>` if rorca itself
   should live on the server.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Forgejo API drift from Gitea compatibility | Hermetic fake server + API-surface spike on the real instance before the projector lands; conformance suite in W5-010 |
| omp CLI flag drift (mode rpc/print) | Pin omp version probe at wave start (`omp --version` + surface snapshot); translate through one adapter module |
| `feat/dms-omp-adapter-20260804` conflicts (user work) | 5B lane inventories it; conflicts surfaced to the user, never resolved silently |
| Same-model review blind spots | Reviewers on alternate provider (gpt-5.6-sol) |
| Operator creds unavailable | Everything except W5-010 is credential-free; demo mirrors W4-010's pre-credential pattern with the fake server |
| Wave branch drift from main (user branches) | Program branch is the integration base; reconcile at gap-closer with `git diff --name-only` proofs |

## 8. Definition of done

- Wave-5 spec generated and approved through `/api/specs` (committed to
  `forge/specs/approved/`), W5-001 gate binding exact prior SHAs.
- Forgejo adapter: credential provider + release authority + check/status
  projector + webhook router, all gate-green against the hermetic fake and
  conformance-green against the operator's server (W5-010).
- Federation result proposal → Forgejo draft PR + status projection at the
  exact head (W4-010 residual closed for Forgejo).
- OMP shim: `OmpManagedExecutor` live, continuation controller wired,
  `omp` an engine agent kind, rorca extension + skills verified under omp,
  hermes↔omp provenance tools ported.
- Reviews: security + release ACCEPT at exact SHA, zero findings; clean-room
  cert real-host; final ledger `MERGE-READY: YES` with only operator
  credentials as residual.
