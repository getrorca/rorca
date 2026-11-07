# Rorca Genesis — Bridge and Implementation Plan

## Linear Document Draft

**Status:** Implemented locally (pending remote publish)  
**Owner:** Product / Platform  
**Created:** 2026-06-28  
**Related documents:**

- `docs/prds/rorca-genesis/linear-document.md`
- `forge/specs/approved/rorca-context-intelligence-platform.json`
- `packages/rorca-pi-extension/skills/rorca-forge/SKILL.md`
- `packages/rorca-pi-extension/skills/rorca-forge-run/SKILL.md`

## One-line summary

Rorca Genesis should bridge to existing Rorca with a minimal, explicit **Genesis handoff → Rorca spec** contract: Genesis produces approved product intelligence; Rorca turns it into executable specs and runs.

## Progress update (2026-07-09)

This bridge is now implemented in the repo and validated locally:
- Implemented in `backend/src/lib/genesis-rorca-bridge.ts`, `backend/src/scripts/genesis-to-rorca-spec.ts`, and `packages/rorca-pi-extension/skills/rorca-genesis-to-spec/SKILL.md`.
- Loads explicit Genesis spec-ready packages only.
- Fetches `rorca_specs_generation_context` before persistence.
- Drafts stories locally, then persists via `rorca_create_spec` / `rorca_persist_spec`.
- Writes `contextUsed.genesis` and `contextSummary.genesis`.
- Reads the saved spec back before claiming success.
- Local Genesis validation passed after merge.

## Why this document exists

The core Genesis vision is now clear:

```txt
Genesis: idea → knowledge → research → hypothesis → validation plan → approved product bet
Rorca:   approved product bet → spec → build → ship
Genesis: metrics + feedback → learning → next product bet
```

This document answers the implementation question:

> How does that connect to the existing Rorca source code, spec forge skills, MCP tools, APIs, folders, and UI without overbuilding?

## Core decision

Genesis should remain mostly Rorca-agnostic until the handoff point.

```txt
Genesis = research / knowledge / validation system
Rorca   = spec / build / execution system
Bridge  = approved handoff → create_spec
```

This keeps the system simple:

- Genesis can exist as filesystem/Obsidian/DuckBrain/Rorca-local artifacts.
- Rorca does not need to blindly crawl arbitrary folders.
- The first useful bridge can reuse the existing forge/persist contract.
- A formal Genesis API can be added later only where it clearly adds value.

## Current Rorca source-code connection

Rorca already has the key extension points needed for a v0 bridge.

### Current spec creation flow

Preferred skill-first path today:

```txt
Pi skill drafts spec
  → rorca_specs_generation_context
  → rorca_create_spec / rorca_persist_spec
  → backend validates/enriches/persists
  → optional approve/run
```

Important existing files:

- `packages/rorca-pi-extension/skills/rorca-forge/SKILL.md`
- `packages/rorca-pi-extension/skills/rorca-forge-run/SKILL.md`
- `packages/rorca-pi-extension/extensions/rorca/skill-launcher.ts`
- `backend/src/routes/specs.ts`
- `src/api/specs.ts`
- `src/panels/SpecsPanel.tsx`

### Existing contracts Genesis can reuse

The canonical explicit persistence contract already supports:

- `title`
- `slug`
- `brief`
- `stories`
- `contextUsed`
- `contextSummary`
- `policyPresetId`
- `postSavePolicy`

This means Genesis does not need a new spec persistence API for v0.

Genesis can supply:

- the product brief
- the approved plan
- source citations
- decision records
- constraints
- validation metrics
- scope/non-scope
- acceptance criteria hints
- context provenance

Then `rorca_create_spec` / `rorca_persist_spec` can save the result through the normal Rorca path.

### Existing MCP/API tools that are enough for MVP

Use existing structured tools:

- `rorca_specs_generation_context`
- `rorca_create_spec`
- `rorca_persist_spec`
- `rorca_get_specs_by_specId`
- `rorca_spec_workflow`
- `rorca_spec_readiness`
- `rorca_approve_spec`
- `rorca_trigger_run`
- `rorca_save_memory`
- `rorca_put_direction`
- `rorca_recall`
- `rorca_search`

No new backend endpoint is required for the first useful bridge.

## Minimal bridge: Genesis handoff file

The simplest bridge is a file-based handoff.

Recommended folder:

```txt
genesis/
  handoffs/
    recordings-feature.md
```

A handoff is the approved product intelligence package that Rorca consumes.

Example:

```md
# Product Bet: Event Recordings

## Hypothesis
If hosts can record events, paid retention and post-event engagement will improve.

## Evidence
- Source A: Hosts asked for replay access in support tickets.
- Source B: Competitor X gates recordings behind paid tiers.
- Source C: Prior event data shows post-event email engagement.

## Approved Decision
Test recordings as a limited beta for paid hosts.

## Validation Plan

Success:
- 25% of active hosts enable recordings within 30 days.
- Recording users retain 15% better than non-recording users.

Failure:
- <10% host activation after 30 days.
- Storage cost exceeds defined budget without retention lift.

Required metrics:
- `recording_enabled`
- `recording_started`
- `recording_viewed`
- `recording_shared`
- `recording_deleted`

Decision rule:
- Expand if activation + retention targets pass.
- Iterate if activation passes but replay views are low.
- Kill or limit if usage is low and storage cost is high.

## Rorca Spec Scope
Build recordings MVP with instrumentation and an admin usage dashboard.

## Non-goals
- No advanced editor.
- No AI summarization in MVP.
- No public share links until privacy/legal review.
```

## Minimal Pi skill: `rorca-genesis-to-spec`

Add one new Pi skill first, not a large backend surface.

### Purpose

Turn a Genesis handoff file/folder into a canonical Rorca spec.

### Command shape

```txt
/rorca-genesis-to-spec @genesis/handoffs/recordings-feature.md --workspace categoric
```

Optional flags:

```txt
--approve
--run
--save-memories
--update-direction
--policy best_effort
--model deepseek/deepseek-v4-pro
```

### Skill workflow

```txt
1. Read the handoff file.
2. Read linked research/decision/source summaries if referenced.
3. Fetch `rorca_specs_generation_context`.
4. Draft Rorca stories in Pi.
5. Include validation/instrumentation requirements in stories.
6. Build `contextUsed` and `contextSummary` from the handoff + Rorca context bundle.
7. Call `rorca_create_spec`.
8. Read the saved spec back.
9. Check workflow/readiness.
10. Optionally save approved findings to Rorca memory.
11. Optionally update direction stack.
12. Optionally approve/run.
```

### Why a skill first

A skill-first bridge is enough because Pi can already read local files and invoke Rorca MCP tools.

This avoids premature backend complexity:

- no arbitrary backend filesystem crawling
- no new DB schema required for v0
- no UI dependency for initial usefulness
- no security expansion beyond explicit file reads and existing Rorca APIs

## Can Rorca “just look somewhere”?

### In Pi: yes

Pi can read an explicit path such as:

```txt
genesis/
ObsidianVault/
research/*.md
decisions/*.md
plans/*.md
DuckBrain export files
```

Then Pi can call `rorca_create_spec`.

This is the fastest path and requires almost no Rorca backend change.

### In backend/UI: not blindly

The backend should not crawl arbitrary folders by default because of:

- secret leakage risk
- PII/PHI risk
- workspace boundary risk
- accidental huge prompt context
- unclear provenance
- path traversal/symlink risk

Backend/UI should use explicit imports or registered safe roots.

Good patterns:

1. User selects/imports a handoff file.
2. Workspace registers a safe Genesis root.
3. A `genesis/manifest.json` declares allowed source paths.
4. Rorca previews what will be imported before saving.
5. Rorca stores provenance and sensitivity labels.

## Recommended `genesis/` filesystem convention

The bridge should assume a simple convention before formal APIs exist.

```txt
genesis/
  brief.md
  manifest.json
  sources/
    papers/
    competitor-pages/
    supplier-docs/
    regulations/
    transcripts/
  research/
    market-landscape.md
    competitor-matrix.md
    regulatory-risk.md
  decisions/
    DEC-001-positioning.md
    DEC-002-claims-policy.md
  validation/
    BET-001-recordings.md
  handoffs/
    recordings-feature.md
  memories/
    candidate-findings.jsonl
  plans/
    launch-plan.md
    roadmap.md
  specs/
```

### `manifest.json` v0

Optional but useful.

```json
{
  "version": 1,
  "workspaceId": "categoric",
  "projectName": "Categoric",
  "safeRoots": [
    "sources",
    "research",
    "decisions",
    "validation",
    "handoffs",
    "plans"
  ],
  "defaultSensitivity": "internal",
  "canonicalRorcaWorkspace": "categoric",
  "obsidianMirror": true,
  "duckbrainLocalMirror": true
}
```

## What Genesis should hand to Rorca

A complete handoff should include:

### 1. Brief

What is being built and why.

### 2. Approved plan

The bounded product direction the user approved.

### 3. Hypothesis

The testable belief behind the feature/product bet.

### 4. Evidence

Key findings and citations that justify the bet.

### 5. Decisions

Explicit commitments and constraints.

### 6. Validation plan

Success/failure thresholds, time windows, and decision rules.

### 7. Metric contract

Required instrumentation events and dashboard/reporting needs.

### 8. Scope / non-scope

What is in the first pass and what is explicitly excluded.

### 9. Acceptance criteria hints

Input for Rorca story generation.

### 10. Security/sensitivity labels

What context can be sent to which models/providers.

## How a Rorca spec should change when generated from Genesis

Genesis-generated specs should include more than functional stories.

Every generated spec should carry:

- product hypothesis
- target user / segment
- linked decisions
- source citations / evidence summary
- success metrics
- failure metrics
- analytics events required
- feedback collection plan
- launch criteria
- kill/expand/iterate decision rule
- post-launch review task

### Example story impact

Bad story:

> As a host, I can record an event.

Better Genesis-informed story:

> As a host, I can enable recording for an event so attendees can replay sessions after the event.
>
> Acceptance criteria:
> - Host can enable/disable recording before event start.
> - System emits `recording_enabled` with host, event, plan tier, and timestamp.
> - System emits `recording_started` and `recording_failed` during event lifecycle.
> - Recording availability is visible after processing.
> - Basic usage data is exposed for validation review.
> - Privacy copy is shown before enabling recording.

## Product validation loop

Miguel’s feedback changes Genesis from “beginning only” to lifecycle product intelligence.

Genesis should be used throughout the product lifecycle.

```txt
Idea
  ↓
Research
  ↓
Findings
  ↓
Opportunities
  ↓
Hypotheses
  ↓
Validation Plan
  ↓
Approved Product Bet
  ↓
Rorca Spec
  ↓
Build / Ship
  ↓
Metrics + Feedback
  ↓
Genesis Review
  ↓
Expand / Iterate / Kill / Pivot
  ↓
Next Product Bet
```

### New first-class Genesis objects

- **Idea** — raw concept.
- **Opportunity** — researched market/problem area.
- **Finding** — evidence-backed observation.
- **Assumption** — belief that may need validation.
- **Hypothesis** — testable product belief.
- **Product Bet** — approved experiment/investment.
- **Validation Plan** — metrics, thresholds, and decision rules.
- **Metric Contract** — events/dashboards required for validation.
- **Research Run** — reproducible investigation with sources/citations.
- **Decision** — commitment with evidence and approval state.
- **Spec Handoff** — approved package sent to Rorca.
- **Experiment Result** — post-launch measurement and interpretation.

## UI-first research capture bridge

Genesis should support users who prefer Gemini UI, ChatGPT UI, Claude UI, or other external research UIs.

Recommended flow:

```txt
External deep-research UI
  ↓
Export/share/save result
  ↓
Genesis inbox/vault
  ↓
Hermes scheduled curator
  ↓
Obsidian local notes + DuckBrain local store
  ↓
Rorca memory/decision/spec promotion
```

### Local-first mode

```txt
Gemini/ChatGPT UI
   ↓
Save/export/share locally
   ↓
Obsidian inbox folder + local DuckBrain store
   ↓
Local Hermes/collector on schedule
   ↓
summaries / notes / decisions / tags / memory candidates
```

### Remote canonical + local mirror mode

```txt
Gemini/ChatGPT UI
   ↓
Save/export/share to remote Genesis vault
   ↓
Hermes remote runs on schedule
   ↓
updates remote artifacts + Rorca canonical state
   ↓
Obsidian syncs to laptop automatically
   ↓
DuckBrain local store refreshes on laptop automatically
```

## Obsidian and DuckBrain positioning

### Obsidian

Human-readable local/project vault.

Good for:

- research reports
- decision memos
- weekly summaries
- source notes
- plans
- roadmaps
- inbox capture from external deep-research UIs

### DuckBrain

Optional local machine-friendly mirror/index on the laptop.

Good for:

- local semantic recall over captured research artifacts
- machine-readable memory/index for laptop workflows
- fast retrieval over curated notes and summaries
- personal/offline recall when synced artifacts already exist locally

### Rorca

Canonical durable execution-aware system of record.

Owns:

- approved memories
- decisions
- specs
- runs
- provenance
- context packing
- readiness
- execution

## Hermes role

Hermes is ideal as the scheduled or background curator.

### Hermes scheduled curator tasks

Every N hours/days:

1. read new inbox captures
2. read new source files
3. read recent Pi/Hermes chats if captured
4. summarize research artifacts
5. extract candidate findings
6. detect implicit decisions
7. propose memory candidates
8. propose decision candidates
9. flag contradictions/stale knowledge
10. update Obsidian notes
11. update local DuckBrain mirror when laptop/local sync is available
12. queue Rorca memory/decision promotions for approval

Hermes should not silently commit high-risk product strategy or regulated-domain decisions.

## Security and safety requirements

The bridge should be explicit and conservative.

### Do not let backend blindly crawl arbitrary paths

Use:

- explicit handoff file path in Pi
- registered safe roots for UI/backend
- manifest allowlists
- source sensitivity labels
- redaction before prompting
- provider/model allowlists
- audit trail for imported context

### Sensitivity labels

Every imported source/handoff should support labels such as:

- `public`
- `internal`
- `confidential`
- `restricted`
- `regulated`

Prompt construction and provider routing should honor these labels.

### Approval gates

Require human approval for:

- memory promotion
- official decisions
- regulated claims
- kill/pivot/expand decisions
- externally published artifacts
- high-impact roadmap changes

## Existing Rorca integration points to reuse

### Spec persistence

Use:

- MCP: `rorca_create_spec` / `rorca_persist_spec`
- API: `POST /api/specs/persist`
- Backend: `backend/src/routes/specs.ts`

Pass:

- `brief`
- `stories`
- `contextUsed`
- `contextSummary`
- `policyPresetId`

### Spec context

Use:

- MCP: `rorca_specs_generation_context`
- API/backend generation context bundle

Add Genesis handoff references into `contextUsed` and `contextSummary` so the Spec Detail Context tab can show that the spec came from a Genesis handoff.

### Memory promotion

Use:

- MCP: `rorca_save_memory`
- Backend memory APIs

Only promote approved Genesis findings.

### Direction stack updates

Use:

- MCP: `rorca_put_direction`

Use this for durable workspace-level strategy/conventions, not for dumping raw research.

Examples:

- positioning decisions
- product principles
- regulated-domain guardrails
- instrumentation expectations

### Search/recall

Use:

- MCP: `rorca_recall`
- MCP: `rorca_search`

The Genesis-to-spec skill should use these to avoid duplicating old decisions or contradicting existing memory.

## Minimal MVP plan

### MVP goal

Allow a user to go from a Genesis handoff file to a saved Rorca spec without new backend architecture.

### Steps

1. Define the `genesis/` folder convention.
2. Define the handoff Markdown template.
3. Add Pi skill `rorca-genesis-to-spec`.
4. Skill reads explicit handoff path.
5. Skill fetches `rorca_specs_generation_context`.
6. Skill drafts Rorca stories with metrics/instrumentation requirements.
7. Skill calls `rorca_create_spec` with `contextUsed` + `contextSummary`.
8. Skill verifies saved spec/workflow/readiness.
9. Optional: skill saves approved memory candidates with `rorca_save_memory`.
10. Optional: skill updates workspace direction with `rorca_put_direction`.

### What MVP does not need

- no new database tables
- no new backend crawler
- no full Genesis UI
- no object storage layer
- no formal entity graph
- no automatic product decision approval

## V1 product/API plan

After v0 proves useful, add a small first-class Genesis API surface.

Potential endpoints/tools:

- `genesis_import_source`
- `genesis_list_sources`
- `genesis_create_research_run`
- `genesis_create_decision`
- `genesis_create_product_bet`
- `genesis_create_validation_plan`
- `genesis_create_spec_handoff`
- `genesis_promote_memory_candidate`
- `genesis_create_rorca_spec_from_handoff`

Potential UI panels:

- Genesis Dashboard
- Source Library
- Research Runs
- Decisions
- Product Bets
- Validation Plans
- Handoffs
- Candidate Review

## V2 lifecycle intelligence plan

Add the product validation loop.

Features:

- metric contracts in specs
- analytics integration
- post-launch review jobs
- expand/iterate/kill recommendations
- product bet ledger
- experiment result records
- validation dashboard
- executive/product review flows

This is likely enterprise-oriented.

## OSS vs enterprise split

### OSS MVP

Keep it lightweight:

- filesystem convention
- handoff files
- Pi skill bridge
- Rorca spec handoff
- optional memory promotion
- optional Obsidian/DuckBrain local mirrors

### Enterprise

Add:

- formal source library
- role-based approval workflows
- analytics integrations
- validation plans and metric contracts
- experiment dashboards
- audit trails
- regulated-domain guardrails
- team collaboration
- policy-based provider routing

## Proposed new skill: `rorca-genesis-to-spec`

### Skill description

Draft a canonical Rorca spec from a Genesis handoff file or folder. Use when the user has completed Genesis research/approval and wants Rorca to create an executable spec.

### Required behavior

- read explicit handoff path only
- inspect linked local research/decision files when referenced
- fetch `rorca_specs_generation_context`
- use `rorca_recall` / `rorca_search` for existing Rorca context
- draft stories with validation/instrumentation requirements
- persist through `rorca_create_spec`
- forward `contextUsed` and `contextSummary`
- verify saved spec/readiness
- never claim success without structured readback

### Output contract

Return:

- saved spec slug
- workspace id
- source handoff path
- product hypothesis
- validation metrics included
- story summary
- policy used
- workflow/readiness state
- next suggested action: approve, edit, or run

## Proposed handoff template

```md
# Genesis Handoff: <name>

## Status
Approved / Draft / Needs review

## Product Bet
<one paragraph>

## Target User / Segment
<who this is for>

## Hypothesis
<testable belief>

## Evidence
- <source/finding/citation>
- <source/finding/citation>

## Decisions
- <approved decision>
- <constraint>

## Validation Plan

### Success Metrics
- <metric + threshold + window>

### Failure Metrics
- <metric + threshold + window>

### Required Analytics Events
- `<event_name>`: <properties>

### Feedback Collection
- <qualitative feedback plan>

### Decision Rule
- Expand if...
- Iterate if...
- Kill/pause if...

## Scope
- <in scope>

## Non-goals
- <out of scope>

## Risks / Guardrails
- <security/compliance/product risk>

## Rorca Spec Request
<what Rorca should turn this into>

## Linked Files
- ../research/<file>.md
- ../decisions/<file>.md
- ../sources/<file or URL>
```

## Final recommendation

The most simplified bridge is:

```txt
genesis/handoffs/*.md
        ↓
/rorca-genesis-to-spec
        ↓
rorca_specs_generation_context
        ↓
Pi drafts canonical stories
        ↓
rorca_create_spec(contextUsed, contextSummary)
        ↓
Rorca validates/enriches/persists
        ↓
approve/run when ready
```

This gives the user a powerful Genesis-to-Rorca workflow immediately, while preserving the larger architecture path for source libraries, validation loops, UI, Hermes curation, Obsidian/DuckBrain mirrors, and enterprise governance.
