# Memory Ledger

## 2026-02-27 [Architecture] Direction Stack 5-Layer Cascade
> Rule: Direction Stack layers cascade L1 (global) → L5 (story annotations). Lower layers override higher ones, like CSS specificity.
> Context: L1-L2 are global engineering/domain principles. L3+ are per-workspace. L4/L5 come from spec brief and story annotations.
> Source: CIE-003

## 2026-02-27 [Convention] Spec ID vs specName
> Rule: spec.id is the filename slug (use for API calls and path construction). spec.specName is the human-readable title (display only).
> Context: Confusing these causes file-not-found errors in pipeline trigger and archive panel.
> Source: v2-platform

## 2026-02-27 [Gotcha] better-sqlite3 is synchronous
> Rule: Never use async/await for better-sqlite3 DB calls. db.prepare().get() returns T|undefined, .all() returns T[], .run() returns RunResult.
> Context: Using async wrappers around synchronous calls adds unnecessary overhead and can cause subtle bugs.
> Source: v2-platform

## 2026-02-27 [Convention] chatComplete returns ChatResult
> Rule: chatComplete() returns ChatResult { text, usage } — always use .text accessor, never treat result as a string.
> Context: The return type was changed from string to ChatResult in US-003 (model selection). All callers must use .text.
> Source: US-003

## 2026-02-27 [Gotcha] Backend requires restart after changes
> Rule: tsx has no hot-reload. Always kill port 3030 and restart after backend changes: lsof -ti:3030 | xargs kill -9 && npm run dev
> Context: Changes to backend code are not picked up automatically. Forgetting to restart causes stale behavior.
> Source: v2-platform

## 2026-02-28 [Architecture] Context Router uses virtual file assembly
> Rule: Context is assembled virtually at runtime — no physical file scatter. Path-based scoping + tag injection + token budget enforcement.
> Context: .rorca/config.json routing section defines globals, scopes, and tags. micromatch handles glob matching.
> Source: CIE-004

## 2026-02-28 [Architecture] Episodic Memory is structured Markdown
> Rule: MEMORY.md entries follow format: ## YYYY-MM-DD [Category] Title / > Rule: / > Context: / > Source: story-id
> Context: Machine-readable, human-editable. Categories: Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha.
> Source: CIE-005

## 2026-03-01 [Gotcha] Wave-based execution blocks dependent stories on single failure
> Rule: When wave execution is enabled, a single story failure in wave 0 causes all dependent stories to skip with reason='blocked_by'
> Context: SM-001 failed in wave 0, causing SM-002, SM-004, and SM-006 to skip despite not being directly tested. This cascading failure pattern means early wave failures have exponential impact on run completion rate.
> Source: SM-001

## 2026-03-01 [Convention] TypeScript typecheck failures require immediate resolution
> Rule: Stories must pass `npx tsc --noEmit` validation before being marked as passed, even if runtime behavior appears correct
> Context: SM-001 failed with reason='typecheck' despite potentially working at runtime. The execution engine enforces strict type safety as a quality gate. Always verify both frontend and backend type checks before committing.
> Source: SM-001

## 2026-03-01 [Pattern] Marketplace UI components follow extract-then-enhance pattern
> Rule: When adding features to marketplace panels, first extract shared utilities (SM-003: renderMarkdown), then build new UI features (SM-005: category filters) on top of the shared foundation
> Context: SM-003 and SM-005 passed while SM-001 failed, suggesting the incremental approach of establishing shared utilities before complex features reduces integration risk.
> Source: SM-003
