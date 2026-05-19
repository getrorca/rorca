# Docs v2 progress

Last updated: 2026-05-20

## Done
- [x] Wrote `forge/specs/pending/rorca-docs-v2.json`
- [x] Persisted the v2 draft through the canonical explicit path: `POST /api/specs/persist`
- [x] Recorded the normalized persisted slug:
  - `rorca-docs-v2-truth-aligned-product-docs-website-refinement`
- [x] Added `landing-page/docs/product-truth-matrix.md`
- [x] Added `landing-page/docs/rorca-docs-v2-execution-plan.md`
- [x] Added typed docs navigation:
  - `landing-page/src/lib/docs-nav.ts`
- [x] Added docs layout/sidebar:
  - `landing-page/src/app/docs/layout.tsx`
  - `landing-page/src/components/docs/DocsSidebar.tsx`
- [x] Reworked `/docs` into a real docs hub that links to actual section pages
- [x] Added first real docs section pages:
  - `/docs/getting-started`
  - `/docs/spec-creation`
  - `/docs/architecture`
  - `/docs/memory-retrieval`
  - `/docs/execution`
  - `/docs/tools`
  - `/docs/pricing-packaging`
  - `/docs/troubleshooting`
- [x] Expanded `/docs/tools` with copy-paste examples for CLI, TUI, MCP, and Pi extension newcomers
- [x] Added a surface-based newcomer callout to `/docs` so readers can jump straight to CLI, TUI, MCP, or Pi extension guidance
- [x] Mirrored that same surface-based guidance on the homepage so first-time visitors can choose CLI, TUI, MCP, or Pi extension quickly
- [x] Tightened public pricing copy so it no longer frames free local usage as spec-generation-only
- [x] Added an auth model + provider matrix to `/docs/tools` and the docs hub so newcomers can see subscription-backed vs API-key-backed provider paths
- [x] Mirrored the provider/auth model note into the root README so the repository landing page matches the website/docs framing
- [x] Added a tiny provider/auth legend to the homepage hero and docs hub for fast newcomer scanning
- [x] Updated pricing/execution metadata copy to better reflect product truth

## Validation
- [x] `cd landing-page && ./node_modules/.bin/next build`
  - passed
  - generated public routes for all new `/docs/*` pages
- [x] targeted phrase audit
  - stale phrases now only appear in guardrail / anti-pattern contexts, not as active product claims in the new docs slice

## In progress
- [ ] Broader parity pass across `/pricing`, `/troubleshooting`, README, and the remaining public pages
- [ ] More visual docs components / workflow diagrams
- [ ] Troubleshooting top-level page cleanup for stale environment guidance

## Notes
- The explicit persist replay used a human title, so the backend created a longer canonical slug than the compact hand-authored filename.
- For now, treat the persisted slug as proof of the create-spec contract and the hand-authored `rorca-docs-v2.json` as the compact planning artifact.
