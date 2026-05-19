# Pi Skill-First Rorca Refactor Plan

Status: Draft architecture / implementation plan

Note: this document has been superseded in naming/scope by:
- `docs/rorca-wide-skill-first-forge-refactor-plan.md`

The content here remains useful, but the newer file name better reflects the final direction: a Rorca-wide skill-first forge architecture, not only a Pi-extension-centric change.

Location context:
- This planning work was requested from a session currently sitting in `Cashflow-App`
- The actual target codebase for this plan is the Rorca repo at:
  `/Users/dimitriteravanessian/rorca-feat-rorca-pi-native-execution-runtime-and-embedded-tui-US-003-1777883551065`
- This document is intentionally saved in the Rorca repo `docs/` directory so implementation can happen from the correct project root

---

## 1. Executive summary

The current Rorca Pi extension is **working**, but its command surface is still too **REST-first** at the front door.

Today, commands such as `/rorca-forge` and `/rorca-forge-run` mostly behave like:

`Pi slash command -> extension REST client -> Rorca backend generates/decides`

That is not the desired long-term architecture.

The desired architecture is:

`Pi slash command -> Pi skill does the reasoning -> MCP/API persists and orchestrates in Rorca`

### The target model
- **Pi skills** become the primary cognitive layer
- **MCP** becomes the preferred structured tool surface
- **REST** remains as a fallback transport where MCP coverage is missing or temporarily unhealthy
- **Rorca backend** remains the source of truth for specs, runs, memory, graph/retrieval context, and PR/merge state

### Why this change matters
A skill-first design better matches the intended product shape:
- more Pi-native
- less dependent on synchronous backend thinking paths
- fewer “thin wrapper” semantics
- better conversational refinement and clarification loops
- cleaner long-term architecture where Rorca owns state, but Pi owns operator cognition

---

## 2. Current state vs target state

## Historical state at time of draft

### Extension front door
- `/rorca-forge` called `deps.api.generateSpec(...)`
- `/rorca-forge-run` called the same REST generation path, then approve, then trigger
- `/rorca-run` was REST-triggered, then Pi executed stories via the backend-managed Pi runtime
- `/rorca-status`, `/rorca-watch`, `/rorca-retry` were structured/API-driven
- MCP was loaded into Pi when the bridge was healthy, but the slash commands themselves were still primarily REST-backed

### Practical consequence
At the time this plan was written, the extension was Pi-native as a UX shell, but its main forge/planning cognition still had not moved fully into the skill-first path.

## Target state

### Skill-first front door
- `/rorca-forge` invokes a **forge skill workflow**
- `/rorca-forge-run` invokes a **forge + approve + run skill workflow**
- `/rorca-approve`, `/rorca-run`, `/rorca-retry` become **skill-mediated** where helpful, even if the underlying action remains a structured MCP/API call
- `/rorca-status` and `/rorca-watch` may remain mostly structured because they are state-display operations, not reasoning-heavy workflows

### Rorca remains authoritative
This refactor does **not** move the system of record into Pi.

Rorca still owns:
- spec persistence
- run state
- story history
- memory rows
- graph / retrieval state
- queueing / triggering
- PR / merge metadata
- auditability

Pi becomes the reasoning/operator layer on top of that state.

---

## 3. Design principles

1. **One brain for state, one brain for cognition**
   - Rorca owns canonical state
   - Pi owns interactive reasoning and operator-facing generation

2. **Prefer MCP over REST for structured mutation/read calls**
   - if a tool can be cleanly exposed via HTTP MCP, use MCP first
   - REST is the fallback, not the primary interface

3. **Skills do the thinking; tools do the mutation**
   - skills draft, refine, explain, decide, clarify
   - MCP/API creates, updates, approves, triggers, fetches, recalls

4. **No loss of current reliability**
   - the current working REST path must remain available behind a fallback seam until the skill-first path is stable

5. **No loss of Rorca memory/KG behavior**
   - moving cognition into Pi must not bypass spec persistence, memory capture, retrieval updates, or run-state recording

6. **Incremental migration**
   - migrate forge first
   - migrate forge-run second
   - migrate approve/run/retry mediation third
   - preserve current live behavior throughout

---

## 4. Desired command behavior after refactor

## 4.1 `/rorca-forge`

### Current
- parse command
- read brief or `@file`
- call REST generate endpoint
- wait for generated slug
- fetch spec
- optionally approve/run

### Target
- parse command
- invoke Pi **forge skill** with the brief, workspace context, and tool policy
- skill performs:
  - brief analysis
  - optional clarification loop
  - spec drafting in-session
  - optional story decomposition/refinement
  - optional context retrieval via MCP
- skill persists the drafted spec to Rorca using MCP-first persistence tools
- extension updates local state with resulting `specSlug`
- if `--approve` or `--run`, the skill or delegated command continues to structured approval/trigger steps

### User experience target
The user should feel that Pi is intelligently working through the brief, not merely relaying it to a backend generation endpoint.

---

## 4.2 `/rorca-forge-run`

### Current
- generate spec via REST
- approve via REST
- trigger run via REST

### Target
- invoke Pi **forge-run skill**
- skill drafts the spec
- skill persists spec to Rorca
- skill summarizes what will be run
- skill approves via MCP/API
- skill triggers canonical run via MCP/API
- extension starts watch flow if requested

### User experience target
This should feel like a Pi-native operator workflow from brief to execution kickoff.

---

## 4.3 `/rorca-approve`

### Current
- approve directly via REST

### Target
- lightweight skill-assisted approval path
- skill loads spec summary/context
- skill explains readiness/risk if needed
- then approves via MCP/API

### Note
This can be partially skill-mediated without becoming overly slow or chatty.

---

## 4.4 `/rorca-run`

### Current
- fetch spec
- resolve model
- trigger run via REST
- watch optionally

### Target
- invoke Pi **run operator skill** or run-decision helper prompt
- skill checks:
  - requested scope
  - workspace state
  - story-specific vs full-spec path
  - model availability
  - possibly relevant recall context
- skill triggers run via MCP/API
- backend continues canonical orchestration and Pi story execution

### Note
This remains less radical than forge. The main gain is operator cognition, explanation, and smarter retries/scope decisions.

---

## 4.5 `/rorca-retry`

### Current
- retry directly via REST

### Target
- invoke Pi **retry planner skill**
- skill examines failed stories/run context
- recommends retry scope
- triggers retry via MCP/API

---

## 4.6 `/rorca-status` and `/rorca-watch`

### Target
These can remain mostly structured and tool/API-driven.

Reason:
- they are primarily read/display flows
- they do not benefit as much from heavy skill mediation
- they should stay fast and deterministic

Skill augmentation can be optional later, e.g. “explain why this run failed,” but not required for the initial refactor.

---

## 5. Required capability changes

A true skill-first forge path requires a different persistence contract than “ask backend to generate a spec.”

Right now, the existing forge generation path is generation-oriented. For skill-first generation, we need persistence-oriented contracts.

## 5.1 New capability required: save a skill-authored spec

The skill needs a way to persist a spec that **Pi already authored**.

### Required operations
- create a new draft/approved spec from explicit structured content
- update an existing drafted spec from explicit structured content
- patch specific stories or sections
- approve a spec
- fetch saved spec detail

### Preferred surface
Expose these as MCP tools first, with REST fallback.

### Likely new tool shapes
- `rorca_spec_create_from_content`
- `rorca_spec_update_from_content`
- `rorca_spec_patch_story`
- `rorca_spec_approve`
- `rorca_spec_get`

### REST fallback equivalents
- `POST /api/specs/from-content`
- `PUT /api/specs/:specId/from-content`
- or similar equivalent route naming

The exact route shape is flexible; the important part is **persisting explicit spec content without backend LLM generation**.

---

## 5.2 Existing tools that should still be used

Where already available and appropriate, the skill-first path should continue to use:
- workspace lookup
- direction stack synthesis
- recall/memory lookup
- run trigger
- run status polling
- Pi model discovery / run config lookup

Examples from the current ecosystem:
- `rorca_get_workspaces`
- `rorca_direction_synthesize`
- `rorca_recall`
- `rorca_pipeline_trigger`
- `rorca_get_pipeline_runs`
- `rorca_get_pipeline_runs_by_runId`

---

## 6. New skills to create

These skills should live with the packaged Pi extension so the versioned extension owns its behavior.

## Recommended new directory
`packages/rorca-pi-extension/skills/`

## 6.1 `rorca-forge.md`

Purpose:
- primary spec-generation skill

Responsibilities:
- read the brief
- identify missing ambiguity
- ask concise clarifying questions only when necessary
- synthesize a Rorca-structured spec draft
- optionally use workspace memory/direction/recall tools before drafting
- persist the draft via MCP/API tools

Output expectations:
- saved `specSlug`
- concise summary
- next action suggestion (`approve`, `run`, or refine)

---

## 6.2 `rorca-forge-run.md`

Purpose:
- end-to-end forge + persist + approve + trigger workflow

Responsibilities:
- call/chain forge behavior
- confirm final execution intent if necessary
- approve saved spec
- resolve execution model
- trigger canonical run
- hand off to watch flow

---

## 6.3 `rorca-approve.md`

Purpose:
- skill-assisted approval

Responsibilities:
- inspect spec summary
- identify obvious quality/risk gaps
- explain approval consequences
- approve via MCP/API when appropriate

---

## 6.4 `rorca-run-operator.md`

Purpose:
- front-door skill for run intent

Responsibilities:
- determine run scope
- validate workspace/spec/story selection
- inspect model availability
- optionally gather recall context
- trigger run cleanly

---

## 6.5 `rorca-retry-planner.md`

Purpose:
- intelligent retry scoping

Responsibilities:
- inspect failed run/story state
- identify smallest safe retry scope
- recommend full-run vs story-only retry
- trigger retry via MCP/API

---

## 6.6 Optional later skills
- `rorca-run-diagnose.md`
- `rorca-spec-refine.md`
- `rorca-story-split.md`
- `rorca-pr-readiness.md`

These are valuable, but not required for the first refactor phase.

---

## 7. Slash command delegation model

This is the most important implementation change in the extension package.

## Current pattern
Command handlers directly call `deps.api.*` methods and then notify the user.

## Target pattern
Command handlers become **thin workflow launchers**.

They should:
1. parse args
2. resolve workspace / brief file / options
3. build a structured instruction payload
4. invoke the skill workflow in Pi
5. let the skill call MCP/API tools to do the actual persistence/mutation
6. optionally attach watcher behavior once a canonical run id exists

---

## 7.1 Preferred implementation mechanism inside the Pi extension

The best first implementation path is to use **Pi-native message delegation** rather than reinventing a sidecar runtime.

### Recommended mechanism
Use `pi.sendUserMessage(...)` or a closely related internal helper that sends a structured prompt into the Pi session, referencing the intended skill and passing a compact execution contract.

This allows:
- the main Pi model to do the cognition
- the current session to own the reasoning flow
- normal tool-calling behavior
- natural clarification exchanges

### Structured pattern
Each slash command should compose a hidden/internal skill-launch prompt such as:
- selected workflow
- workspace id
- brief text or spec slug
- whether approve/run should follow
- whether MCP is healthy
- whether REST fallback is permitted

### Alternative mechanism for later
A subagent process can be introduced later for isolation if needed, using a dedicated `pi` subprocess pattern similar to the official subagent example.

### Recommendation
Start with **same-session skill delegation**, not subprocess subagents.

Reason:
- simpler
- more Pi-native
- less moving parts
- easier to observe and iterate

---

## 7.2 New extension helper module

Add a workflow launcher abstraction.

### New file
`packages/rorca-pi-extension/extensions/rorca/skill-launcher.ts`

Responsibilities:
- format structured skill-launch prompts
- resolve skill file identifiers/paths
- pass workspace/spec/brief options into the prompt
- encode MCP-first / REST-fallback policy
- send the message into the Pi session
- optionally return lightweight bookkeeping state to the command handler

---

## 8. MCP vs REST policy after refactor

## 8.1 Default rule
Use **MCP first** for structured operations when:
- the MCP bridge is healthy
- the needed tool exists
- the tool provides the required mutation semantics

## 8.2 REST fallback
Use REST when:
- MCP bridge is unavailable
- the required tool is not yet exposed
- the mutation is too awkward or not yet represented in the MCP surface
- compatibility fallback is needed during migration

## 8.3 Policy by operation

### Forge/spec drafting
- reasoning: **skill**
- persistence: **MCP preferred**, REST fallback

### Approve spec
- reasoning: optional **skill**
- mutation: **MCP preferred**, REST fallback

### Trigger run
- reasoning: optional **skill**
- mutation: **MCP preferred**, REST fallback

### Status/read/watch
- read: **MCP preferred** where already convenient
- REST acceptable for fast polling if the current watcher already depends on REST and is stable

### Memory/recall/direction
- **MCP preferred**

---

## 9. Exact file changes expected

## 9.1 Extension package

### Files to modify
- `packages/rorca-pi-extension/extensions/rorca/commands.ts`
  - replace direct forge/forge-run/approve/run/retry orchestration with workflow delegation
- `packages/rorca-pi-extension/extensions/rorca/index.ts`
  - register new helper dependencies and initialize skill launch policy
- `packages/rorca-pi-extension/extensions/rorca/bridge.ts`
  - expose bridge health/tool availability in a way skill-launch policy can inspect
- `packages/rorca-pi-extension/extensions/rorca/types.ts`
  - add workflow-launch option types and MCP-fallback policy types
- `packages/rorca-pi-extension/extensions/rorca/state.ts`
  - optionally persist pending workflow metadata / last launch mode
- `packages/rorca-pi-extension/extensions/rorca/README.md` or package `README.md`
  - update architecture docs from REST-first UX to skill-first UX

### Files to add
- `packages/rorca-pi-extension/extensions/rorca/skill-launcher.ts`
- `packages/rorca-pi-extension/extensions/rorca/workflow-prompts.ts`
- `packages/rorca-pi-extension/skills/rorca-forge.md`
- `packages/rorca-pi-extension/skills/rorca-forge-run.md`
- `packages/rorca-pi-extension/skills/rorca-approve.md`
- `packages/rorca-pi-extension/skills/rorca-run-operator.md`
- `packages/rorca-pi-extension/skills/rorca-retry-planner.md`
- new tests covering delegation behavior and fallback policy

---

## 9.2 Backend / MCP surface

### Likely files to modify
- `backend/src/routes/specs.ts`
  - add/create persistence endpoints for skill-authored spec content if missing
- `backend/src/routes/mcp-tools.ts`
  - expose new spec-persistence operations as MCP tools if not already covered cleanly
- `backend/src/mcp/server.ts`
  - ensure new tools are correctly surfaced
- possibly `backend/src/routes/pipeline.ts`
  - if run-trigger improvements are needed for skill-mediated flows

### Possibly new tests
- MCP exposure tests for new spec persistence operations
- route tests for create-from-content / update-from-content
- end-to-end extension tests that verify command -> skill-launch rather than command -> direct REST generation

---

## 10. Phased migration plan

## Phase 0 — planning and seam introduction
Goal:
- add the extension-side workflow launcher seam without changing behavior yet

Deliverables:
- `skill-launcher.ts`
- policy types
- bridge health introspection helper
- no user-facing behavior change yet

Success criteria:
- existing tests still pass
- no command behavior regression

---

## Phase 1 — skill-first `/rorca-forge`
Goal:
- replace direct REST spec generation with skill-authored spec generation + MCP/API persistence

Deliverables:
- `rorca-forge.md`
- explicit spec persistence contract in MCP and/or REST fallback
- `/rorca-forge` delegates to skill launcher

Fallback rule:
- if MCP persistence tools are unavailable, use REST persistence fallback
- if full skill launch is disabled or unhealthy, allow a temporary feature-flagged fallback to the old REST generation path

Success criteria:
- user can forge a spec via Pi skill
- resulting spec is persisted canonically in Rorca
- spec memory capture still works
- suggested skills / direction behavior still works or has an explicit replacement plan

---

## Phase 2 — skill-first `/rorca-forge-run`
Goal:
- make forge-run a true skill-mediated flow

Deliverables:
- `rorca-forge-run.md`
- approval + trigger path via MCP/API after skill drafting
- watcher handoff still works

Success criteria:
- one command creates a skill-authored spec, approves it, and triggers a canonical run
- resulting run is visible in Rorca and Pi watch surfaces

---

## Phase 3 — skill-mediated approve/run/retry
Goal:
- make operator flows smarter without destabilizing the backend

Deliverables:
- `rorca-approve.md`
- `rorca-run-operator.md`
- `rorca-retry-planner.md`
- command handlers become thin intent launchers

Success criteria:
- commands are Pi-native in reasoning behavior
- state mutations still flow through Rorca canonically

---

## Phase 4 — flip default policy to MCP-first, REST-fallback
Goal:
- make MCP the default structured mutation surface where coverage exists

Deliverables:
- final fallback policy in `skill-launcher.ts`
- docs update describing MCP-first architecture

Success criteria:
- REST remains only a fallback for gaps/unhealthy bridge states

---

## Phase 5 — deprecate direct REST generation path
Goal:
- stop treating backend LLM spec generation as the primary front door for the extension

Deliverables:
- old direct `/rorca-forge` REST generation path no longer default
- optional internal feature flag kept briefly for rollback

Success criteria:
- extension identity is now clearly skill-first

---

## 11. Validation plan

## Automated
- extension tests for command delegation
- tests for workspace/brief parsing still passing
- tests for MCP-first / REST-fallback policy decisions
- backend tests for new spec persistence routes/tools
- MCP exposure tests

## Live runtime verification
- `/rorca-forge` using a packaged skill, not backend generation
- `/rorca-forge-run` end-to-end through Pi skill
- MCP tool usage visible in session/tool logs
- spec saved correctly in Rorca
- recall/memory behavior still present
- approval and run trigger still canonical
- single-story run path still exact-once

## Observability checks
- run state still accurate
- memory rows still persisted
- graph context still updated where expected
- no regression in PR/merge metadata behavior

---

## 12. Risks and mitigations

## Risk 1: skill-first persistence path is incomplete
Mitigation:
- add explicit create/update-from-content contracts before switching default behavior

## Risk 2: MCP bridge instability degrades UX
Mitigation:
- keep REST fallback policy during migration
- expose bridge-health-aware decision logic

## Risk 3: skill-generated specs drift from Rorca expectations
Mitigation:
- encode a strict spec-shape contract in the forge skill
- validate content before persistence
- keep backend validation authoritative

## Risk 4: command UX becomes too chatty or slow
Mitigation:
- keep clarification bounded
- default to concise behavior
- use skill templates that optimize for quick action

## Risk 5: users lose confidence during transition
Mitigation:
- phased rollout
- feature flag for old forge path
- explicit docs describing current vs new path

---

## 13. Acceptance criteria for “done”

This refactor should be considered complete when all of the following are true:

1. `/rorca-forge` no longer depends primarily on backend-side spec generation
2. `/rorca-forge` uses a Pi skill as the main reasoning layer
3. the skill persists specs into Rorca canonically through MCP-first structured operations
4. REST is fallback, not primary, for forge persistence/mutation
5. `/rorca-forge-run` is skill-mediated end to end
6. `/rorca-run` and `/rorca-retry` are at least lightly skill-mediated
7. Rorca remains the canonical source of truth for state and history
8. memory / retrieval / graph behavior remains intact
9. extension docs clearly describe the new skill-first architecture
10. live verification proves the new path, not just tests

---

## 14. Recommended first implementation step

The first coding step should **not** be rewriting all commands at once.

It should be:

### Step 1
Introduce the extension-side workflow-launch seam:
- add `skill-launcher.ts`
- teach `commands.ts` to delegate behind a feature flag or internal switch
- preserve the current working REST path temporarily

### Step 2
Add the new skill-authored spec persistence contract to Rorca/MCP

### Step 3
Convert `/rorca-forge`

That sequence gives the highest architectural leverage with the lowest regression risk.

---

## 15. Bottom line

The current extension is a solid runtime and packaging foundation, but it is still too REST-first at the front door.

The next architectural move is to make the Pi extension truly **skill-first**, with:
- Pi doing the reasoning
- MCP/API doing the structured persistence and orchestration
- Rorca remaining the authoritative control plane

That is the model that best matches the intended long-term shape of Rorca as a Pi-native agent workflow system.

---

## 16. Superseding architecture correction: this change should apply across Rorca, not just the Pi extension

The earlier sections in this document focused primarily on the packaged Pi extension.

That is no longer the full target.

### Updated conclusion
The desired change is **Rorca-wide**, not extension-only.

The Rorca UI, shared backend forge flow, CLI, and Pi extension should all converge on the same underlying skill-first forge architecture.

### Updated north star
Not:

`surface -> backend generation endpoint does the thinking`

But:

`surface -> shared forge workflow -> Pi skill/runtime does the reasoning -> Rorca enriches/persists canonically`

### Why this mattered
Earlier, there was a real risk of surface drift, where the Pi extension and the dashboard would follow different forge behaviors and produce inconsistent product semantics.

That drift is exactly what the shared forge migration was meant to remove.

### Updated rule
All main product surfaces should eventually use the same shared forge workflow:
- Rorca UI
- Rorca CLI
- Pi extension
- backend-triggered forge flows
- future automation surfaces where appropriate

The goal is one forge brain with multiple front doors.

---

## 17. Clarification on MCP’s role

MCP is a good fit for:
- structured reads
- structured writes
- persistence
- status
- retrieval
- triggering actions
- tool invocation

MCP is **not** the preferred primitive for the main act of spec generation.

### Updated rule
Spec generation itself should be performed by a Pi skill/runtime.

MCP should support the workflow around that generation, such as:
- retrieving context
- saving drafted content
- approving the spec
- triggering a run
- recalling memory
- reading status

### Implication
The future Rorca forge architecture should be:
- **skill-first for generation and reasoning**
- **tool/MCP/internal-service-based for structured operations**
- **backend-owned for enrichment, validation, and persistence**

---

## 18. Clarification on “contract”

In this plan, a **contract** means the exact boundary agreement between system components.

A contract defines things like:
- what input shape is accepted
- what output shape is returned
- what side effects occur
- what guarantees are made
- what errors or failure modes are possible

### Example
If Rorca introduces a `create spec from explicit content` capability, its contract should define:
- the required spec-draft fields
- whether enrichment is enabled
- whether skill matching runs
- whether memory synthesis runs
- what slug/id is returned
- how validation failures are surfaced

This matters because the skill-first design depends on clear separation between:
- drafting the spec
- enriching/persisting the spec

---

## 19. Updated model of the current `rorca_generate_spec` behavior

A key correction from later discussion:

`rorca_generate_spec` should not be thought of as “an MCP tool that orchestrates other MCP tools.”

A better model is:

`MCP or REST surface -> backend forge pipeline -> backend internal services -> result`

### Why this matters
The current backend forge path likely bundles several valuable behaviors together, including some mix of:
- context enrichment
- retrieval / recall influence
- spec drafting/generation
- story skill suggestion matching
- persistence
- post-save memory synthesis hooks
- graph / retrieval indexing hooks

The refactor should **not** throw these away.

### Updated decomposition rule
We should separate the current monolithic forge behavior into three conceptual layers:

1. **Context gathering**
   - directions
   - recall / memory
   - related specs
   - relevant retrieval/graph context
   - curated skill-library inputs

2. **Reasoning and drafting**
   - understanding the brief
   - asking clarifying questions
   - decomposing into stories
   - writing the actual spec draft

3. **Enrichment and persistence**
   - validation
   - normalization
   - story skill matching
   - metadata attachment
   - memory synthesis
   - indexing / graph hooks
   - canonical save

### Updated ownership split
The skill should replace **backend spec-writing**, not **backend spec-enrichment/persistence**.

---

## 20. New universal architecture rule: skills think, tools fetch, backend saves

This is the cleanest summary of the revised architecture.

### Skills think
Skills/runtimes should own:
- brief interpretation
- clarifying questions
- retrieval strategy
- context synthesis
- decomposition into stories
- spec-writing cognition
- retry scoping / operator reasoning where relevant

### Tools fetch
Structured tools should own:
- retrieval execution
- memory lookup
- graph traversal
- related-spec lookup
- workspace/direction reads
- persistence mutations
- approval actions
- run triggering
- status reads

### Backend saves
The Rorca backend should remain authoritative for:
- validation
- normalization
- skill matching
- memory synthesis
- graph / retrieval update hooks
- canonical persistence
- audit trail
- run state
- PR/merge metadata

---

## 21. Skill-guided retrieval and validation is technically feasible and desirable

An important refinement from later discussion:

The skill should not merely draft from a static preloaded context blob.
It should be allowed to **actively guide retrieval**.

### Important distinction
The skill does **not** perform retrieval by itself.

Instead:
- the skill decides what to retrieve and how to interpret it
- tools/backend perform the actual retrieval
- then the skill evaluates the result
- then the skill may request further retrieval if needed

### Canonical pattern

`skill thinks -> tool fetches memories/context -> skill evaluates relevance/gaps/conflicts -> tool fetches more if needed -> skill drafts better spec`

### Why this is powerful
This allows the skill to:
- decide whether to use CAG, RAG, GraphRAG, or a mix
- reject noisy or irrelevant retrieval
- detect stale or contradictory context
- refine retrieval queries iteratively
- prefer approved spec context over noisy historical artifacts when appropriate
- ask for more retrieval only when confidence is low

### Updated rule
The skill should orchestrate retrieval and validate relevance.
The backend/tools should execute retrieval operations and return structured data.

---

## 22. Applying CAG / RAG / GraphRAG in the new model

The later discussion strongly suggests that retrieval should become more explicit and skill-guided.

### Old shape
A backend generation path may do something like:
- retrieve once
- stuff results into a prompt
- generate

### Better new shape
A skill-first workflow can:
1. retrieve candidate context
2. inspect the quality of that context
3. detect mismatch or missing context
4. reformulate the retrieval request
5. compare sources
6. retrieve again if needed
7. synthesize a more accurate spec

### Updated principle
CAG, RAG, and GraphRAG should not be treated as hidden prompt magic.
They should be treated as **retrieval capabilities that the skill can deliberately use, compare, and validate**.

---

## 23. Revised Rorca-wide forge flow

The product-wide target flow is now:

`surface request -> shared forge workflow -> skill-guided context retrieval -> Pi skill/runtime drafts canonical spec -> Rorca enriches/persists -> saved spec returned`

### More explicit version
1. a surface initiates forge
   - UI
   - CLI
   - Pi extension
   - internal backend automation
2. a shared forge workflow starts in the backend
3. that workflow launches Pi skill/runtime for reasoning
4. the skill:
   - validates workspace
   - gathers directions / recall / graph/spec context
   - validates whether the retrieved memories are actually relevant
   - asks clarifying questions if required
   - drafts the spec
5. the drafted spec is handed to Rorca’s enrichment/persistence layer
6. the backend:
   - validates and normalizes the draft
   - runs story-level curated skill suggestion logic
   - triggers spec-memory synthesis
   - triggers graph/retrieval update hooks
   - persists the canonical spec
7. the saved spec is returned to the initiating surface

### Consequence
The UI should eventually work this way too.
The Pi extension should not be the only skill-first surface.

---

## 24. Revised implementation focus: backend forge workflow first, extension second

Given the updated direction, the primary implementation center should shift.

### Earlier emphasis
- packaged Pi extension command delegation

### Updated emphasis
- shared backend forge workflow used by every surface

### Recommended backend-centered modules
These names are conceptual and may be adapted to existing conventions:
- `backend/src/lib/forge-workflow.ts`
- `backend/src/lib/forge-context.ts`
- `backend/src/lib/forge-persistence.ts`
- `backend/src/lib/pi-forge-runner.ts`
- `backend/src/lib/spec-enrichment.ts`

### Responsibilities
#### `forge-workflow.ts`
- common orchestration entry point for all surfaces

#### `forge-context.ts`
- context/retrieval preparation adapters
- direction / recall / graph/spec lookup helpers

#### `pi-forge-runner.ts`
- launch the Pi skill/runtime for drafting
- support clarifying turns and retrieval-guided loops

#### `spec-enrichment.ts` / `forge-persistence.ts`
- validate drafted content
- normalize
- run story skill matching
- save spec
- trigger memory and indexing hooks

### Surface integration after this refactor
- UI calls shared forge workflow
- CLI calls shared forge workflow
- Pi extension either calls shared forge workflow or uses a local skill UX layer that still converges on the same backend persistence logic

---

## 25. Revised skill text requirements

The future forge skill should explicitly encode the architecture we refined later.

### It must say, in substance
- you are the spec generator
- do not hand spec generation back to a backend generation endpoint by default
- use tools/internal operations to gather retrieval context
- validate whether the retrieved memories are relevant
- retrieve again if needed
- draft the canonical spec yourself
- hand the result to Rorca for enrichment and persistence

### It must not imply
- MCP is the spec generator
- backend generation remains the default front door
- a single blind retrieval pass is always enough

---

## 26. Revised phased migration plan

The earlier phased plan remains useful, but it should be superseded by this broader sequence.

### Revised Phase A — extract backend forge layers
Goal:
- separate current forge behavior into reusable pieces

Deliverables:
- context gathering seam
- drafting seam
- enrichment/persistence seam
- legacy forge path still works through the same reusable internals where possible

### Revised Phase B — introduce shared Pi-backed forge workflow
Goal:
- backend can launch a Pi skill/runtime to perform spec drafting for any surface

Deliverables:
- shared forge workflow
- Pi forge runner
- backend persistence contract for drafted content

### Revised Phase C — switch UI/backend forge path to skill-first
Goal:
- Rorca’s primary forge path becomes skill-first even outside the Pi extension

Deliverables:
- UI/backend forge uses shared Pi-backed forge workflow
- legacy backend-only generation path moves behind fallback/feature flag

### Revised Phase D — converge Pi extension and CLI on the same forge workflow
Goal:
- all major surfaces use the same underlying generation architecture

Deliverables:
- extension/CLI delegate into the shared workflow or into equivalent skill-first paths that preserve the same backend persistence semantics

### Revised Phase E — optimize retrieval guidance and skill matching reuse
Goal:
- improve skill-guided retrieval loops and preserve/enhance story skill suggestion quality

Deliverables:
- retrieval strategy improvements
- relevance validation logic
- curated skill matching remains canonical backend logic

---

## 27. Revised acceptance criteria for the full architecture

The broader refactor should be considered complete when all of the following are true:

1. Rorca’s main forge path is skill-first across the product, not only in the Pi extension
2. spec generation reasoning is performed by Pi skill/runtime rather than by backend generation endpoints as the primary path
3. the skill can guide retrieval and validate relevance before drafting
4. CAG / RAG / GraphRAG style retrieval is available as structured capability, not hidden monolithic generation behavior
5. story-level curated skill suggestion logic is preserved canonically in backend enrichment/persistence
6. spec memory synthesis still occurs after spec persistence
7. graph / retrieval indexing hooks still occur after spec persistence
8. Rorca UI, CLI, and Pi extension converge on the same forge architecture
9. MCP remains a structured operations layer rather than the primary spec generator
10. live verification proves the new path in the UI/backend flow as well as Pi-facing surfaces

---

## 28. Final updated bottom line

The earlier extension-focused plan was directionally correct, but incomplete.

The more accurate final plan is:
- make **Rorca-wide forge** skill-first
- let the **skill guide retrieval and validate relevance**
- keep **tools/MCP/internal services** responsible for retrieval execution and structured mutation
- keep **Rorca backend** authoritative for validation, enrichment, persistence, memory hooks, graph hooks, and canonical state

In the shortest possible form:

**skills think, tools fetch, backend saves**

That is now the intended target architecture.
