# Rorca-Wide Skill-First Forge Implementation Checklist

Status: Draft implementation checklist / execution spec

This checklist turns the higher-level architecture plan into concrete implementation work.

Primary companion doc:
- `docs/rorca-wide-skill-first-forge-refactor-plan.md`

---

## 1. Goal

Make Rorca’s forge path skill-first across the product.

That means:
- Pi skill/runtime performs spec-generation reasoning
- retrieval is guided and validated by the skill
- structured tools/internal services perform retrieval and mutation
- Rorca backend remains authoritative for validation, enrichment, persistence, memory hooks, graph hooks, and canonical state

---

## 2. Definition of success

This work is successful when:
- the main forge path used by UI/backend is skill-first
- CLI and Pi extension converge on the same forge architecture
- legacy backend-generation-first forge path is no longer the default
- spec-memory synthesis still works
- story-level curated skill suggestion logic still works
- retrieval/graph enrichment still works
- live verification proves the new path end to end

---

## 3. Workstream A — extract current forge behavior into reusable backend seams

### Goal
Separate existing forge behavior into reusable layers instead of one monolithic path.

### Target seams
- [ ] `forge-context` seam
- [ ] `forge-drafting` seam
- [ ] `forge-persistence/enrichment` seam

### Candidate files
- [ ] inspect current forge/spec generation route and service code
- [ ] identify where context gathering currently happens
- [ ] identify where model/spec drafting currently happens
- [ ] identify where skill matching currently happens
- [ ] identify where spec-memory synthesis currently happens
- [ ] identify where graph/retrieval update hooks currently happen

### Deliverables
- [ ] document current forge call graph
- [ ] extract shared helpers where practical
- [ ] ensure legacy forge path can still call the extracted helpers during migration

---

## 4. Workstream B — introduce a shared backend forge workflow

### Goal
Create one backend entry point that all surfaces can use.

### Candidate new modules
- [ ] `backend/src/lib/forge-workflow.ts`
- [ ] `backend/src/lib/forge-context.ts`
- [ ] `backend/src/lib/forge-persistence.ts`
- [ ] `backend/src/lib/spec-enrichment.ts`
- [ ] `backend/src/lib/pi-forge-runner.ts`

### Responsibilities
#### `forge-workflow.ts`
- [ ] accept normalized forge request input
- [ ] orchestrate context, drafting, persistence, and response shaping
- [ ] remain surface-agnostic

#### `forge-context.ts`
- [ ] gather direction stack context
- [ ] gather recall/memory context
- [ ] gather related approved spec context
- [ ] gather retrieval/graph context
- [ ] expose these in a form usable by a Pi skill/runtime

#### `pi-forge-runner.ts`
- [ ] launch Pi skill/runtime for spec drafting
- [ ] support retrieval-guided loops
- [ ] support clarifying question loops where needed
- [ ] return explicit drafted content, not just prose

#### `forge-persistence.ts` / `spec-enrichment.ts`
- [ ] validate draft shape
- [ ] normalize slug/title/metadata
- [ ] run story skill suggestion matching
- [ ] persist canonical spec
- [ ] trigger spec-memory synthesis
- [ ] trigger retrieval/index/graph update hooks

---

## 5. Workstream C — define the drafted-spec persistence contract

### Goal
Allow Pi to author the spec while Rorca remains the canonical saver/enricher.

### Required contract decisions
- [ ] draft input shape
- [ ] required vs optional spec fields
- [ ] story structure requirements
- [ ] validation error shape
- [ ] enrichment flags
- [ ] skill matching behavior
- [ ] memory synthesis behavior
- [ ] returned slug/id shape

### Candidate contract capabilities
- [ ] create spec from explicit content
- [ ] update spec from explicit content
- [ ] patch story from explicit content
- [ ] approve spec
- [ ] fetch saved spec for verification

### Deliverables
- [ ] backend TypeScript types/interfaces
- [ ] route/input validation schema
- [ ] internal service contract
- [ ] tests for valid/invalid drafted content

---

## 6. Workstream D — make retrieval skill-guided instead of hidden prompt magic

### Goal
Let the skill decide what context to retrieve and whether the retrieval is good enough.

### Retrieval capabilities the skill should be able to use
- [ ] workspace validation
- [ ] direction synthesis
- [ ] memory/recall lookup
- [ ] related approved spec lookup
- [ ] graph/retrieval traversal or summaries
- [ ] curated skill-library preview or matching hints if useful

### Retrieval behavior requirements
- [ ] skill can request first-pass context
- [ ] skill can evaluate relevance/gaps/conflicts
- [ ] skill can request additional retrieval if confidence is low
- [ ] skill can reject stale/noisy retrieval
- [ ] skill can prefer approved/spec-level context over noisy artifacts when appropriate

### Deliverables
- [ ] explicit retrieval adapters/tools available to skill runtime
- [ ] launcher/runtime prompt contract that encourages iterative retrieval
- [ ] tests or traces showing multi-step retrieval behavior

---

## 7. Workstream E — create the actual skill files and launcher behavior

### Goal
Encode the new architecture in reusable skill text.

### Skill files
- [x] `packages/rorca-pi-extension/skills/rorca-forge/SKILL.md`
- [x] `packages/rorca-pi-extension/skills/rorca-forge-run/SKILL.md`
- [x] `packages/rorca-pi-extension/skills/rorca-approve/SKILL.md`
- [x] `packages/rorca-pi-extension/skills/rorca-run-operator/SKILL.md`
- [x] `packages/rorca-pi-extension/skills/rorca-retry-planner/SKILL.md`

### Remaining work
- [ ] review skill text against actual backend capabilities
- [ ] decide whether these skills live only in the package or are also mirrored for backend-owned Pi runtime usage
- [ ] create any shared prompt/launcher utilities needed to invoke them
- [ ] add tests or smoke checks that the skills load correctly

### Required skill behavior
- [ ] explicitly forbid default fallback to backend generation endpoints
- [ ] explicitly allow guided retrieval and relevance validation
- [ ] explicitly hand drafted specs to backend persistence/enrichment

---

## 8. Workstream F — integrate the shared forge workflow into the backend/UI path

### Goal
Make the Rorca UI/backend use the new skill-first flow.

### Candidate areas
- [ ] UI forge trigger endpoint(s)
- [ ] backend specs route / forge route
- [ ] any existing backend spec-generation service
- [ ] run-now / approve-after-forge flow if coupled to current forge behavior

### Deliverables
- [ ] UI/backend forge calls shared `forge-workflow`
- [ ] backend launches Pi runtime for drafting
- [ ] UI receives canonical saved spec result
- [ ] loading/progress/error states remain user-friendly

### Key rule
- [ ] UI should not remain on a separate backend-generation-first path once migration is complete

---

## 9. Workstream G — integrate CLI and Pi extension

### Goal
Converge other front doors on the same forge architecture.

### CLI
- [ ] identify current CLI forge path
- [ ] route CLI forge through shared forge workflow
- [ ] preserve CLI ergonomics and output

### Pi extension
- [ ] decide whether extension delegates to shared forge workflow or uses local skill UX plus shared backend persistence path
- [ ] if using local skill UX, ensure behavior still matches the same backend enrichment/persistence semantics
- [ ] keep `/rorca-forge-run` aligned with the shared architecture

### Important note
- [ ] avoid creating a second independent forge brain inside the extension

---

## 10. Workstream H — preserve curated skill matching and spec-memory behavior

### Goal
Ensure the smart backend-specific value does not regress.

### Must preserve
- [ ] story-level curated skill suggestion matching
- [ ] spec-memory synthesis
- [ ] graph/retrieval update hooks
- [ ] saved spec metadata conventions
- [ ] validation/normalization behavior

### Deliverables
- [ ] tests asserting suggested skill fields still appear when expected
- [ ] tests asserting memory synthesis still occurs after save
- [ ] tests/assertions for graph/retrieval side effects where practical

---

## 11. Workstream I — fallback and rollout safety

### Goal
Ship incrementally without breaking current users.

### Safety requirements
- [ ] keep legacy forge path behind a feature flag during migration
- [ ] support structured fallback when MCP is unavailable and fallback is allowed
- [ ] expose clear runtime logging for which path executed
- [ ] make it obvious whether a spec was skill-authored or legacy-generated

### Deliverables
- [ ] feature flag or runtime switch
- [ ] logging/telemetry notes
- [ ] rollback plan

---

## 12. Workstream J — testing and live verification

### Automated tests
- [ ] backend unit tests for forge workflow pieces
- [ ] contract tests for create/update-from-content behavior
- [ ] retrieval adapter/tool tests where practical
- [ ] extension launcher/delegation tests if extension-local skill launching is used
- [ ] CLI/route tests updated for new flow

### Live verification
- [ ] UI-triggered forge uses Pi skill/runtime
- [ ] CLI-triggered forge uses shared skill-first workflow
- [ ] Pi extension forge uses the intended skill-first behavior
- [ ] saved spec includes expected story structure
- [ ] suggested skills still appear where expected
- [ ] spec memories are stored
- [ ] retrieval/graph hooks still update
- [ ] downstream approve/run still work

### Evidence to capture
- [ ] logs/traces proving skill-first path executed
- [ ] saved spec artifact
- [ ] memory rows or equivalent persistence proof
- [ ] graph/retrieval update proof if available

---

## 13. Suggested execution order

### Phase 1
- [ ] extract backend seams
- [ ] define drafted-spec persistence contract
- [ ] create shared forge workflow skeleton

### Phase 2
- [ ] add Pi forge runner
- [ ] wire retrieval-guided drafting
- [ ] preserve persistence/enrichment hooks

### Phase 3
- [ ] switch backend/UI forge to shared skill-first path
- [ ] validate live behavior

### Phase 4
- [ ] converge CLI and Pi extension
- [ ] keep fallback path available briefly

### Phase 5
- [ ] remove default reliance on legacy backend-generation-first forge
- [ ] keep only intentional fallback/rollback path if still needed

---

## 14. Final summary

This checklist exists to enforce the architecture we actually want:

- **skills think**
- **tools fetch**
- **backend saves**

And to make sure that applies across the full Rorca product, not only the Pi extension.
