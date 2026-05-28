# In-depth operator docs progress

## Goal
Add in-depth website docs for the Rorca CLI, embedded TUI, and Pi extension, with dense usage guidance, flags/arguments, execution-engine examples, sequential vs wave-parallel guidance, and copy-paste run/retry/watch/attach patterns.

## Requirements snapshot
- Website docs must cover CLI, TUI, and Pi extension in depth.
- Include many execution examples across Claude Code CLI, Codex CLI, OpenCode, and Pi where applicable.
- Include important flags/arguments, not just command names.
- Explain sequential vs wave-parallel clearly.
- Map equivalent actions across surfaces.
- Keep docs product-truth accurate to current implementation.

## Plan
1. Audit current docs gaps and actual surface capabilities.
2. Add dedicated docs pages for CLI, TUI, and Pi extension.
3. Expand execution docs with orchestration/engine guidance and cross-surface mappings.
4. Update docs navigation + overview + tools page to route users into the dense guides.
5. Run landing-page validation and fix any issues.
6. Re-check requirements coverage before declaring done.

## Progress
- 2026-05-26: Audited current website docs; existing coverage is overview-level only.
- 2026-05-26: Audited actual CLI, TUI, and Pi extension capabilities from source for product-truth docs.
- 2026-05-26: Added new dedicated docs pages for `/docs/cli`, `/docs/tui`, and `/docs/pi-extension`.
- 2026-05-26: Rewrote `/docs/execution` toward engine selection + orchestration behavior instead of only conceptual framing.
- 2026-05-26: Updated `/docs/tools`, `/docs`, and docs navigation to route users into the dense guides.
- 2026-05-26: Added explicit examples for execution CLI engines, run/retry/watch flows, and sequential mode coverage.
- 2026-05-26: Fixed an unrelated landing-page build blocker in `/changelog` so full production build validation could complete.
- 2026-05-26: Follow-up pass — rewrote `/docs/getting-started` into a true beginner guide centered on the dashboard/UI first-run path.
- 2026-05-26: Added explicit beginner coverage for Settings → Providers & Models, Marketplace/skills.sh/custom skills, automatic skill relevance matching, and story include/exclude selection before runs.
- 2026-05-26: Updated `/docs` and docs navigation copy so newcomers are pointed at the beginner guide first.

## Validation log
- 2026-05-26: `cd landing-page && npx tsc --noEmit` ✅
- 2026-05-26: Re-ran `cd landing-page && npx tsc --noEmit` after completeness pass ✅
- 2026-05-26: `cd landing-page && npm run build` ✅
- 2026-05-26: Follow-up validation — parallel `npx tsc --noEmit` raced with `.next/types` generation once; reran sequentially after build ✅
- 2026-05-26: `cd landing-page && npx tsc --noEmit` ✅
- 2026-05-26: `cd landing-page && npm run build` ✅

## Known risks / caveats
- CLI `rorca run` currently has no explicit `--workspace` flag; docs now state workspace is inferred from the approved spec slug.
- Pi extension `/rorca-run` is Pi-only as an execution surface; docs now call out that it does not choose Claude/Codex/OpenCode executors.
- TUI supports agent/model switching and board/watch flows, but docs intentionally avoid overstating unsupported per-run override semantics beyond the current implementation.
