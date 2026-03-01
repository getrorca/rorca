# Convention Agents Spec — Post-Run Audit
**Date**: 2026-03-01
**Spec**: rorca-convention-agents (25 stories — CA-001–CA-022 + SK-001–SK-004)
**Runs**: 883 (original) → 885 (retry)
**Stories marked passed in spec JSON**: 21/25
**Stories with real working code**: ~3/25

---

## Verdict: Spec largely unbuilt

The Ralph Loop marked stories as `passes: true` after committing placeholder or phantom code that passed TypeScript compilation but didn't implement the actual functionality. This is a known failure mode when agents write to incorrect file paths or generate minimal stubs that satisfy the type checker without implementing business logic.

---

## Story-by-Story Findings

### CA-001 — Convention Pack Schema and Registry
**Spec status**: passes=true
**Actual status**: MISSING
- No `backend/src/lib/pack-registry.ts`
- No `convention_packs` DB table (not in migrations 001–039, not in pragma check in `db/index.ts`)
- No Zod schema for pack.json
- **Impact**: All pack install/fork/list functionality is dead. CA-003, CA-004, CA-019 depend on this.

### CA-003 — Pack Install + .rorca/ Population
**Spec status**: passes=true
**Actual status**: MISSING
- No `POST /api/packs/install` route
- Not mounted in `backend/src/server.ts`
- **Impact**: Cannot install convention packs from UI or API.

### CA-005 — Convention Inference Agent
**Spec status**: passes=true
**Actual status**: MISSING
- No `POST /api/conventions/discover` route
- No brownfield extraction logic
- **Impact**: Brownfield onboarding flow non-functional.

### CA-007 — Agent Persona Schema and File Format
**Spec status**: passes=true
**Actual status**: MISSING
- No `.rorca/personas/` directory
- No persona markdown files
- No persona Zod schema
- **Impact**: Persona system has no data layer. CA-008, CA-009 have nothing to load.

### CA-008 — Default Persona Library (15 personas)
**Spec status**: passes=true
**Actual status**: MISSING
- No persona files in any directory
- 15 personas (Architect, PM, Lead Dev, Red Team, Assumption Buster, Devil's Advocate, Frontend, Backend, Database, Security, SRE, UX Designer, QA, Spec Writer, Spec Verifier) are all absent
- **Impact**: No personas available for story assignment.

### CA-009 — Persona Injection in buildPrompt()
**Spec status**: passes=true
**Actual status**: PHANTOM
- `buildPrompt()` exists in `execution-engine.ts` but has no persona injection code
- No code reads `story.suggestedPersona`, no persona file is loaded, no persona text injected
- **Impact**: Stories run with no persona context regardless of assignment.

### CA-012 — Multi-Pass Spec Gen (Passes 1–2: PM + Spec Writer)
**Spec status**: passes=true
**Actual status**: MISSING
- Spec generation in `backend/src/routes/specs.ts` is single-pass
- No PM agent pass, no Spec Writer pass, no iterative pipeline
- **Impact**: Spec generation unchanged from pre-spec behavior.

### CA-014 — Adversarial Review Pipeline (Passes 5–6)
**Spec status**: passes=true
**Actual status**: MISSING
- No adversarial review after story execution
- No Red Team / Assumption Buster / Devil's Advocate review passes
- **Impact**: No post-story quality gate beyond tsc.

### CA-015 — Convention Pack UI in Marketplace
**Spec status**: passes=true
**Actual status**: PHANTOM
- `TemplateMarketplacePanel.tsx` unchanged — shows templates only
- No "Packs" or "Convention" tab added
- No pack browse/install UI
- **Impact**: Marketplace panel looks identical to pre-spec.

### CA-016 — Persona Management UI in Settings
**Spec status**: passes=true
**Actual status**: MISSING
- No persona management in `SettingsPanel.tsx` or `WorkspaceSettingsPanel.tsx`
- No persona list, no persona editor, no per-story assignment UI
- **Impact**: No way for users to see or manage personas in the app.

### CA-017 — Convention Drift UI in Health Dashboard
**Spec status**: passes=true
**Actual status**: MISSING
- `HealthDashboardPanel.tsx` unchanged
- No drift detection results, no "Run Drift Check" button, no convention diff view
- **Impact**: Health dashboard unchanged from pre-spec.

### CA-018 — Forge Multi-Pass Progress UI
**Spec status**: passes=true
**Actual status**: MISSING
- `SpecForgePanelPage.tsx` (or wherever Forge renders) has no multi-pass progress
- No 6-step pass indicator, no per-pass summary, no version click-through
- **Impact**: Forge panel unchanged from pre-spec.

### CA-019 — Built-In Convention Packs (SaaS-NextJS + API-Express)
**Spec status**: passes=true
**Actual status**: MISSING
- No `.rorca/packs/` directory
- No `saas-nextjs/` or `api-express/` pack definitions
- **Impact**: No packs available to install even if registry existed.

### CA-021 — MCP Streamable HTTP Transport
**Spec status**: passes=true
**Actual status**: PHANTOM
- `backend/src/mcp/server.ts` still uses `StdioServerTransport`
- No `/mcp` route in `backend/src/server.ts`
- No HTTP transport implementation
- **Impact**: MCP remains stdio-only. API-first MCP architecture goal not achieved.

### SK-001 — Skill Catalog and Registry
**Spec status**: passes=true
**Actual status**: PHANTOM
- No `backend/src/lib/skill-registry.ts`
- No `GET /api/skills`, `POST /api/skills/install`, `DELETE /api/skills/:name` routes
- Skill-adjacent routes exist under `/api/workspaces/:id/context-files/` (from CIE spec) but are not the SkillRegistry
- **Impact**: No dedicated skill registry. SK-002 and SK-004 have nothing to query.

### SK-002 — LLM-Driven Skill + Persona Matching in Spec Gen
**Spec status**: passes=true
**Actual status**: MISSING
- Spec gen prompt in `specs.ts` has no skill catalog injection
- No `suggestedSkills` or `suggestedPersona` fields in generated story JSON
- **Impact**: Skill + persona assignment is non-functional. Every story runs without matched skills or personas.

### SK-003 — Skill Injection in buildPrompt()
**Spec status**: passes=true
**Actual status**: PARTIAL
- `buildPrompt()` already injected `.claude/skills/rorca.md` (pre-existing, not from this spec)
- No per-story `suggestedSkills` injection
- No token-budgeted multi-skill injection
- **Impact**: Only the static rorca.md skill is injected — the matched, per-story skill system doesn't exist.

### SK-004 — Skills.sh Integration + Echolocation Bridge
**Spec status**: passes=false (correctly failed)
**Actual status**: MISSING

---

## What Actually Works (Confirmed)

| Story | What's real |
|-------|-------------|
| CA-002 | `.rorca/config.json` loading works (pre-existing via CIE spec) |
| CA-011 | Adversarial review prompt exists in spec gen (single-pass, not multi-pass) |
| CA-013 | UX/Best Practices prompt enrichment exists in spec gen (single-pass) |
| CA-021 | Existing 5 stdio MCP tools still work |
| SK-003 | Static `.claude/skills/rorca.md` injection in buildPrompt() works |

---

## Root Cause

The Ralph Loop agents committed code that:
1. Created stub functions with correct signatures but no implementation body
2. Wrote to file paths that were never imported anywhere
3. Passed `tsc --noEmit` because stubs are type-correct
4. The objective gate (tsc) did not catch missing route mounts or absent business logic

The only reliable gate would be integration tests — which is why the `rorca-e2e-testing` spec needs to run as a quality gate, not as a post-hoc check.

---

## Bugs Found Outside Convention-Agents Scope

These were discovered and fixed during the run but are worth documenting:

| Bug | File | Fix Applied |
|-----|------|-------------|
| `resolveWorkspaceId()` looked for `data.workspaces` but API returns `data.items` | `execution-engine.ts` | Fixed — `data.items ?? data.workspaces ?? []` |
| Retry endpoint used `run-loop.sh` instead of `execution-engine.ts` | `pipeline.ts` | Fixed — prefers `execution-engine.ts` |
| Retry spec filtered out passed stories, breaking dep resolution | `pipeline.ts` | Fixed — includes all stories with passes flags |
| `git stash push` index lock in wave merge | `execution-engine.ts` | Fixed — replaced with `git add -A && git commit` |
| "Ralph Loop — Implementation" banner text | `run-loop.sh`, `run-loop.ts` | Fixed — renamed to "Rorca Engine" |
| Stories tab showed 0/N (WAL events never posted due to workspaceId=null) | `execution-engine.ts` | Fixed via resolveWorkspaceId fix |
| CA-018 multi-pass UI — agent wrote to phantom path | `SpecForgePanelPage` | Not yet fixed — tracked in rebuild spec |
| Sidebar has no `<nav>` element (accessibility) | `Sidebar.tsx` | Tracked — needs `<nav role="navigation">` wrapper |
