# SSDLC Autonomy Contracts — Delta Against Existing Hermes SSDLC Specs

## Scope and assumption

This comparison treats the prior/last SSDLC foundation spec as:

- Hermes repo: `~/hermes-rorca`
- Spec: `forge/specs/approved/hermes-autonomy-skill-registry-and-ssdlc-policy-kit.json`
- Title: **Hermes Autonomy Skill Registry and SSDLC Policy Kit**
- Story prefix: `HSS-*`

Related existing specs that partially cover the same space:

- `hermes-ssdlc-principle-map-and-skill-canon.json` (`HPM-*`): principle-map / prompt-bundle layer.
- `hermes-persistent-rorca-retry-supervisor.json` (`HRS-*`): retry supervisor / checkpoint / delayed retry layer.

The new gap set comes from the Rorca/Hermes incidents observed during MCR/UCC/HRS/ChatOps runs and from the new document section in `docs/prds/rorca-genesis/linear-document.md` titled `SSDLC autonomy contracts for complete end-to-end execution`.

---

## What the existing HSS SSDLC policy-kit already implemented

### HSS-001 — Registry, policy schema, and seed skill catalog

Implemented foundation:

- Versioned SSDLC/autonomy skill registry contract.
- Governance-vs-guidance boundary.
- Seed principal-level skill catalog, including:
  - `spec-scope-review`
  - `architecture-tradeoff-review`
  - `principal-code-review`
  - `complexity-data-access-review`
  - `threat-model-stride-review`
  - `authz-secret-redaction-review`
  - `idempotency-retry-review`
  - `test-plan-quality-review`
  - `operational-readiness-review`
  - `pr-evidence-handoff-review`
- Safe defaults:
  - dry-run first
  - branch/PR-only
  - no auto-merge
  - no deploys
  - high-risk confirmation required
  - kill switch/fail-closed behavior
- Actual artifact: `policies/ssdlc-policy-kit.json`.
- Actual implementation: `src/runtime/autonomy-skill-registry.ts`, `src/runtime/ssdlc-contract.ts`.

### HSS-002 — Deterministic skill selection and validation profile resolution

Implemented foundation:

- Deterministic matcher for task/spec/run/story context.
- Validation profiles:
  - `docs-only`
  - `code-change`
  - `data-storage`
  - `security-sensitive`
  - `release-ops`
  - `autonomy-runner`
- Matching uses explicit tags, source type, risk level, changed-file hints, command category, and lifecycle phase.
- Actual implementation: `src/runtime/autonomy-skill-matcher.ts`.
- Actual docs: `docs/autonomy-skill-matcher.md`.

### HSS-003 — SSDLC policy engine and command guard

Implemented foundation:

- Policy decisions: allow, confirm, block, emergency-stop.
- Hard-deny command classes.
- Branch/PR-only and no-auto-merge enforcement before runner dispatch.
- Kill switch blocks mutation while preserving read-only status/preflight.
- Skill findings can influence warn/block/confirm policy decisions.
- Actual implementation: `src/runtime/policy.ts`.
- Covered by `tests/policy.test.ts` and golden policy fixtures.

### HSS-004 — Runner lifecycle wiring

Implemented foundation:

- Runner preparation can include selected skills, validation profile, policy decision, and evidence requirements.
- Blocked/emergency-stop decisions refuse runner start before mutation.
- Confirm-class work requires human confirmation path.
- Progress logs and evidence summaries include policy decisions.
- Rorca IDs and Hermes evidence pointers remain distinct.
- Actual implementation appears through `src/runtime/autonomous-runner.ts`, `src/runtime/repair-dispatcher.ts`, and related tests.

### HSS-005 — Normalized evidence and diagnosis contract

Implemented foundation:

- Common evidence fields:
  - `source`
  - `sourceId`
  - `category`
  - `severity`
  - `confidence`
  - `summary`
  - `redactedDetails`
  - `suggestedNextStep`
- Fixtures/adapters for GitHub, Linear, Rorca, and future Git Reins-shaped signals.
- Secret/token redaction before rendering/persistence.
- Uncertain/conflicting evidence represented as uncertain rather than upgraded to pass.
- Actual implementation: evidence runtime/tests such as `tests/evidence.test.ts`, `tests/fixtures/evidence-signals.json`.

### HSS-006 — Tests and operator docs

Implemented foundation:

- Operator guide: `docs/ssdlc-policy-kit-operator-guide.md`.
- Skill authoring template and reusable skill output contract.
- Local validation commands.
- Golden fixtures for principal-level review cases.
- Actual tests include:
  - `tests/autonomy-skill-registry.test.ts`
  - `tests/ssdlc-policy-kit-golden.test.ts`
  - `tests/policy.test.ts`

---

## What related later specs already cover partially

### HPM — Principle Map and Skill Canon

Covers or intends to cover:

- Source/book/standard → distilled principle → SSDLC phase → skill → trigger → gate → evidence → prompt injection.
- Phase taxonomy:
  - `intake_spec`
  - `architecture_review`
  - `implementation_review`
  - `validation_review`
  - `pr_release_review`
  - `post_merge_learning`
- Prompt-bundle generation and principle selection.
- Source citation guardrails.

Implementation evidence in Hermes includes files such as:

- `src/runtime/principle-map.ts`
- `src/runtime/principle-corpus.ts`
- `docs/principle-resolver.md`
- `docs/principle-canon-maintenance.md`
- `tests/principle-map.test.ts`
- `tests/principle-map-golden-evals.test.ts`

Caveat: the approved HPM spec file still shows `passes:false` for all stories, so the spec-state ledger may be stale even though code/docs/tests exist.

### HRS — Persistent Rorca Retry Supervisor

Covers or intends to cover:

- Retry supervisor authority boundary.
- Queue/worker telemetry as read-only evidence.
- Checkpointable partial story work before retry.
- Retryable-vs-real-failure classification.
- Delayed retry scheduler, leases, backoff, duplicate suppression.
- Exact replay of original governed run options.
- Retry budgets, fallback-policy gates, quarantine.
- Operator status/evidence/kill switches.
- Dry-run proof and armed rollout docs.

The HRS approved spec marks `HRS-001` through `HRS-009` as passed. This overlaps with several new gaps, but mostly on the Hermes supervisor side, not on Rorca's canonical story pass contract.

---

## Exact gaps identified beyond HSS

### Gap 1 — Canonical story completion packets

**Status in HSS:** Missing.

HSS defines skill/evidence output contracts, but not a required per-Rorca-story completion packet.

Existing coverage:

- HSS has reusable skill output JSON.
- HSS/HPM have evidence and principle IDs.
- Rorca has progress markdown and `story_results`.

Missing exact contract:

- A machine-readable packet per story with:
  - story ID
  - acceptance criteria evidence
  - files changed
  - commits
  - validation commands/results
  - known issues with classification
  - safe-to-commit / safe-to-pass
  - next recommended action
- Pass-gate enforcement that requires this packet before marking the story passed.
- Agreement checks between packet, progress markdown, DB story result, commits, and approved spec state.

Why it matters:

- MCR exposed that agent success and clean worktree were insufficient to decide story pass.
- UCC exposed that progress state required manual inspection.

### Gap 2 — Rorca-native pass-state reconciler

**Status in HSS:** Missing.

HSS has evidence contracts and policy gates, but not reconciliation of Rorca approved spec `passes` flags against `story_results` and commits.

Existing coverage:

- HRS-003 includes pass-state reconciliation as part of checkpoint harvest.
- Rorca worker has partial retry spec pass-flag syncing after retry completion.

Missing exact contract:

- A standalone pre-run/pre-retry reconciler that compares:
  - approved spec `passes`
  - `story_results`
  - story completion packets
  - commits since story start / checkpoint commits
  - progress files
  - dependency DAG
- Safe update of approved spec flags when evidence is sufficient.
- Ambiguous-state report when not sufficient.

Why it matters:

- The UCC retry intended for `UCC-008` re-ran prior stories because spec flags and copied results diverged.

### Gap 3 — Rorca story pass gate is not fully contract-driven

**Status in HSS:** Partially covered conceptually, missing in Rorca as full contract.

Existing coverage:

- HSS policy gate exists in Hermes.
- Rorca pass gate now checks agent-created commits since story start after the MCR fix.

Missing exact contract:

- Pass gate requiring:
  - completion packet
  - acceptance criteria mapping
  - validation evidence classification
  - no runtime-only metadata-only pass
  - commit or checkpoint evidence
  - baseline-failure classification
- A formal story-output schema shared between Rorca and Hermes.

Why it matters:

- MCR showed clean worktree can hide agent-created commits.
- Existing fix handles one bug but does not yet create a full completion contract.

### Gap 4 — Worktree freshness as a first-class preflight skill

**Status in HSS:** Missing.

Existing coverage:

- Rorca has stale reusable worktree detection.
- HRS includes governed branch/worktree lifecycle concepts.

Missing exact contract:

- A deterministic skill/preflight that:
  - detects stale base, missing branch, dirty unrelated state, conflict risk;
  - preserves commits during safe refresh;
  - writes repair evidence;
  - refuses destructive reset without approval.

Why it matters:

- UCC retry was initially blocked by stale reusable worktree and required manual merge refresh.

### Gap 5 — Retry-scope verification before worker spawn

**Status in HSS:** Missing.

Existing coverage:

- HRS-004/HRS-006 define smallest-safe-scope and exact replay.
- Rorca has retry APIs and worker retry handler.

Missing exact contract:

- Rorca/Hermes must verify actual temp retry spec execution plan before spawning the engine.
- If requested scope differs from actual planned stories, block or request override.
- Report copied/skipped/executed/remaining stories before run start.

Why it matters:

- UCC retry intent and actual execution diverged.

### Gap 6 — Canonical liveness/heartbeat classification

**Status in HSS:** Missing.

Existing coverage:

- HSS has evidence contracts.
- HRS-002 covers queue/worker telemetry as evidence.
- Rorca emits WAL token events and stores run/story rows.

Missing exact contract:

- Aggregated liveness classifier using:
  - process tree
  - WAL token events
  - log mtime
  - PTY events
  - DB story/run status
  - git diff/commits
- Persisted last meaningful activity timestamp.
- Operator-visible classification: active, quiet-active, stalled, blocked, completed, unknown.

Why it matters:

- Run was alive via token WAL events while `pipeline_runs.last_heartbeat` was empty.
- User had to ask whether story 7/8 was stuck after ~90 minutes.

### Gap 7 — Baseline validation failure classification in story closeout

**Status in HSS:** Partially covered by validation profiles; missing in story completion/pass gate.

Existing coverage:

- HSS validation profiles define required checks by work type.
- HSS evidence schema can represent severity/confidence/outcome.

Missing exact contract:

- Per-story classification of validation failures as:
  - story-caused blocker
  - unrelated baseline
  - environment/credential issue
  - follow-up
- Pass-gate rule for when unrelated baseline failures can coexist with a story pass.
- Evidence pointers for baseline classification.

Why it matters:

- UCC stories repeatedly passed focused checks while broad backend type/lint/build failed due unrelated existing PTY/execution-engine errors.

### Gap 8 — Artifact-sync validation as an explicit contract

**Status in HSS:** Missing.

Existing coverage:

- HSS has validation profiles, but no artifact-sync rule category.

Missing exact contract:

- Workspace/package rules for source/generated/runtime artifact pairs.
- Checks that `.ts` and checked-in `.js` runtime files, public contracts, generated docs, etc. are synchronized.
- Artifact-sync results in story packets and merge-readiness reports.

Why it matters:

- UCC required TypeScript and checked-in JavaScript runtime artifacts to be kept in sync.

### Gap 9 — Merge-readiness and canary-evidence contracts

**Status in HSS:** Partially covered as PR handoff and no-auto-merge policy; missing as complete live canary contract.

Existing coverage:

- HSS includes `pr-evidence-handoff-review`.
- HSS defaults enforce no auto-merge/deploy.
- MCR spec/run is building practical merge/canary readiness evidence.

Missing exact contract:

- Merge-readiness result schema:
  - PR-ready
  - merge-ready
  - blocked
  - needs-canary
  - needs-human-approval
- Canary evidence schema:
  - target environment/channel
  - credential status
  - safe/dry-run mode
  - actions performed
  - observed outputs
  - rollback plan
  - result classification
- Hard rule: high-risk integration cannot be merge-ready without canary evidence or explicit canary-blocked classification.

Why it matters:

- Hermes Modular ChatOps is locally validated but not fully live Slack E2E proven.

### Gap 10 — Faithful interactive PTY evidence

**Status in HSS:** Missing.

Existing coverage:

- HSS does not target terminal/PTY runtime.
- Rorca has partial PTY support and a separate PTY plan/spec.

Missing exact contract:

- Real CLI terminal output as evidence.
- PTY heartbeat/completion markers participating in liveness classification.
- Operator can inspect live terminal without falling back to DB/log/git spelunking.

Why it matters:

- Current PTY mode does not reliably show the real CLI session.

### Gap 11 — Run closeout memory/decision/follow-up synthesis

**Status in HSS:** Partial via evidence and later HRS/HRC repair-learning; missing as universal run closeout.

Existing coverage:

- Rorca memory system exists.
- HSS has evidence contracts.
- Later Hermes closed-loop/federation work includes repair learning.

Missing exact contract:

- At every run closeout, synthesize candidate memories/decisions/gotchas/follow-ups from:
  - story packets
  - validation incidents
  - retry/scope decisions
  - pass-gate fixes
  - worktree repairs
  - canary results
- Link candidates to run ID, spec slug, story ID, commits, files.
- Human review before promotion when appropriate.

Why it matters:

- Lessons from MCR no-code misclassification, UCC stale worktree, and retry drift were manually captured rather than universally harvested.

### Gap 12 — Operator report skill that unifies DB/WAL/git/log/PTY/progress evidence

**Status in HSS:** Missing.

Existing coverage:

- HSS has evidence schema.
- HRS-008 exposes supervisor status/evidence/approvals/kill switches.

Missing exact contract:

- A deterministic report that answers:
  - is the run active or stuck?
  - what story is really executing?
  - what changed?
  - what evidence exists?
  - what validation passed/failed?
  - what is the next safe action?
- Inputs:
  - DB run/story status
  - WAL events
  - process tree
  - logs
  - PTY state
  - git diff/commits
  - progress files
  - completion packets

Why it matters:

- The user question “is story 7/8 stuck?” required manual multi-source investigation.

---

## Condensed coverage matrix

| Capability | HSS policy-kit | HPM principle-map | HRS retry-supervisor | Still missing / exact delta |
|---|---:|---:|---:|---|
| Skill registry | Yes | Extends | Uses indirectly | Rorca-side skill contract enforcement per story. |
| SSDLC policy guard | Yes | Extends with principles | Uses | Rorca pass gate still not fully packet/evidence-driven. |
| Evidence schema | Yes | Adds principle IDs | Uses | Story completion packet and canary schema missing. |
| Validation profiles | Yes | Adds phase routing | Uses | Baseline-vs-story failure classification missing. |
| Deterministic skill selection | Yes | More advanced phase/principle resolver | Uses | Not yet tied to Rorca story pass packets. |
| Retry supervisor | No | No | Yes | Rorca pre-spawn scope verification and pass-state reconciliation still needed. |
| Checkpoint partial work | No | No | Yes | Needs canonical Rorca completion/pass-state surface. |
| Pass-state reconciliation | No | No | Partial | Standalone reconciler before every retry/run missing. |
| Worktree freshness repair | No | No | Partial | Dedicated preflight skill/evidence contract missing. |
| Liveness classification | No | No | Partial telemetry | Canonical multi-signal active/stalled classifier missing. |
| Merge readiness | PR handoff only | PR/release phase principles | Some operator status | Structured merge-readiness/canary evidence contract missing. |
| True PTY evidence | No | No | No | Separate Rorca PTY implementation needed. |
| Run closeout memory | No | Post-merge learning phase | Partial repair learning | Universal Rorca/Hermes closeout candidate synthesis missing. |
| Operator report | No | No | Partial supervisor status | Unified DB/WAL/git/log/PTY/progress report missing. |

---

## Bottom line

The last SSDLC foundation spec successfully implemented the **policy, skill, evidence, validation, and fail-closed governance substrate**.

It did **not** implement the full end-to-end Rorca/Hermes autonomous completion loop. The missing layer is mostly about **durable execution-state contracts**:

1. story completion packets;
2. pass-state reconciliation;
3. retry-scope verification;
4. worktree freshness repair;
5. liveness classification;
6. baseline validation classification;
7. artifact-sync checks;
8. merge/canary evidence;
9. true PTY evidence;
10. universal run closeout memory;
11. unified operator report.

In short:

> HSS made autonomy governable. The missing work makes autonomy reliably completable and recoverable end to end.
