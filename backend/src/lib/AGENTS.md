# AGENTS.md — backend/src/lib/

Core service libraries. None are Express routes — they're pure logic called by routes.

## Library Inventory

| File | Purpose |
|------|---------|
| `llm-client.ts` | Multi-provider LLM abstraction (claude-cli, anthropic, openai-compat, openrouter). Returns `ChatResult { text, usage }` |
| `sse-hub.ts` | WAL event broadcast to SSE subscribers |
| `direction-stack.ts` | Synthesize all 5 layers into a single context string |
| `schema-hydrator.ts` | Extract CREATE TABLE blocks from migrations/*.sql (no DB connection) |
| `git-hydrator.ts` | LLM map-reduce over git history → memory.yaml |
| `context-extractor.ts` | Multi-source YAML context extraction (file, paste, URL) |
| `spec-writer.ts` | Write generated spec JSON to disk |
| `diagram-generator.ts` | Generate Mermaid + ASCII dep graphs from story list |
| `execution-engine.ts` | Universal TypeScript execution engine — spawns claude/opencode/codex per story, handles retries, writes WAL events. **Built by rorca-opencode-integration spec.** |
| `finops-accounting.ts` | **FIN-002** shared, DB-free accounting layer. Classifies usage into `metered_api`/`subscription`/`managed`/`free_local`/`unknown`, computes metered cost (tokens × pricing), allocates flat subscription cost (`none`/`even`/`by_tokens`/`by_runs`/`by_stories`/`by_active_days`), and returns blended effective cost plus coverage/provenance. Pure functions reused by historical/per-run FinOps, provider aggregation, and CSV export. Subscription marginal cost is always 0. |
| `spec-post-save.ts` | Durable post-save orchestration for persisted specs. Manages stage lifecycle (enrich → matchSkills dependency chain), pg-boss job enqueue/advance, and generation-log stage sync. Pure-logic `buildPersistPostSaveStages()` + async `enqueuePersistPostSaveJobs()`, `advancePersistPostSaveDependencies()`, `syncPersistPostSaveStageFromJob()`, `getEffectiveGenerationLog()`. |
| `context-trace.ts` | Canonical context-trace contract (CTM-001). `ContextTraceEvent` (lightweight SSE/WAL metadata) + `ContextTraceArtifactWriter` (append-only gzip NDJSON raw-payload artifacts under `.rorca/traces/<runId>.ndjson.gz`). Deterministic `rawRef` = `r{runId}:{seq}`. All writer ops are nonfatal. |

## llm-client.ts

```typescript
import { chatComplete } from '../lib/llm-client';

// Default (claude-cli, uses Claude subscription)
const result = await chatComplete([{ role: 'user', content: prompt }]);

// Explicit provider + model
const result2 = await chatComplete(messages, {
  provider: 'openai-compat',
  model: 'gpt-4o',
  apiKey: '...',
  baseUrl: 'https://api.openai.com/v1',
});

const text = result.text;       // ALWAYS use .text — result is ChatResult, NOT a string
const usage = result.usage;     // { inputTokens, outputTokens }
```

**Providers**: `claude-cli` (default, subscription), `anthropic` (SDK), `openai-compat` (OpenAI/Groq/Together/DeepSeek/Mistral/Ollama), `openrouter` (Gemini/Grok/etc)

**Provider resolution order**: explicit `opts.provider` → model registry lookup → apiKey implies `anthropic` → `claude-cli`

**Critical**: removes all 4 Claude Code env vars before spawning nested processes (so Claude Code can invoke Claude Code). This is already done in `llm-client.ts` — don't duplicate in other files.

## sse-hub.ts

```typescript
import { broadcastAll } from '../lib/sse-hub';

// Emit a WAL event to all connected SSE clients:
broadcastAll(walEvent);  // walEvent = WalEvent row from DB

// To attach a new SSE connection (in routes):
import { attachSSE } from '../lib/sse-hub';
attachSSE(res);  // sets headers, keeps connection alive, cleans up on close
```

`attachSSE()` sets `Content-Type: text/event-stream`, writes ping keepalive every 30s, removes subscriber on disconnect.

## direction-stack.ts

```typescript
import { synthesizeDirectionStack } from '../lib/direction-stack';

const context = await synthesizeDirectionStack(workspaceId, {
  specBrief: '...',           // L4 — one paragraph
  storyAnnotations: '...',    // L5 — optional per-story hints
});
// Returns markdown string: L1 header + L2 header + L3 + schema + git memory + brief
```

Internally reads L1–L3 from DB via `direction_layers`, optionally appends schema snapshot and git memory if hydrated in `workspace_context`.

## schema-hydrator.ts

Pure file parsing — reads SQL files, extracts `CREATE TABLE` blocks:
```typescript
import { hydrateSchema } from '../lib/schema-hydrator';

const snapshot = await hydrateSchema(workspacePath);
// Returns: { snapshot: string, tables: string[], fileCount: number }
// Reads all *.sql files in workspace/backend/src/db/migrations/
```

Does NOT open any DB connection. Safe to call any time.

## git-hydrator.ts

LLM-powered, non-deterministic. Map-reduce over git history:
```typescript
import { hydrateGitMemory } from '../lib/git-hydrator';

const memory = await hydrateGitMemory(workspacePath);
// Returns YAML string (memory.yaml content)
// Map: chunk commits → LLM summary per chunk
// Reduce: merge all chunk summaries → single memory.yaml
```

Expensive — only call on workspace hydration request, not on every spec generation.

## spec-writer.ts

```typescript
import { writeSpec } from '../lib/spec-writer';

await writeSpec(workspacePath, slug, specContent);
// Writes to: workspace/forge/specs/pending/<slug>.json
```

Creates directories if missing. Overwrites if exists (used on regenerate).

## execution-engine.ts

Planned canonical execution engine — replaces the legacy bash runner entirely. Built by `rorca-opencode-integration` spec.

**Responsibilities**:
- Per-story process spawning (`claude --print`, `opencode run`, or `codex exec`) based on `RORCA_AGENT` env var; PTY-only flags are capability-probed at launch
- Strips 4 Claude Code env vars before spawning nested processes
- Selective retry: skip already-passed stories on re-run
- WAL events emitted: `run_started`, `story_started`, `story_passed`, `story_failed`, `story_skipped`, `run_finished`, `run_blocked`, `story_escalated`
- Invoked only via `POST /api/pipeline/trigger` — never called directly from other routes

**RORCA_AGENT values**: `claude` (default, subscription) | `opencode` (OpenCode CLI) | `codex` (Codex CLI, ChatGPT subscription)

**Model cascading**: only active when `RORCA_AGENT=opencode` with API keys (Haiku → Sonnet → Opus on failure). Disabled for `claude` and `codex` (flat-rate subscriptions).

## context-trace.ts

```typescript
import { createContextTraceWriter, lookupTraceRecord } from '../lib/context-trace';
import { broadcastAll } from '../lib/sse-hub';

// Per run: open an append-only artifact writer (nonfatal — never throws).
const writer = createContextTraceWriter(cwd, runId);

// Append a heavy raw payload OFF the hot path, get a lightweight event back.
const event = writer.appendEvent('context', heavyContextPayload, {
  status: 'ok',
  storyId: 'US-001',
  metrics: { tokens: 1234, fileCount: 3 },
  label: 'L1-L5 synthesis',
});
// event.rawRef === 'r<runId>:<seq>' — emit the lightweight event only.
if (event) broadcastAll(/* map event into WalEvent shape */);

await writer.close(); // idempotent

// Later: lazily recover the full payload by rawRef (no schema guessing).
const record = lookupTraceRecord(cwd, event!.rawRef);
```

**Contract invariants**:
- `rawRef` is deterministic + monotonic *within a run*: `r{runId}:{seq}` (gap-free, seq zero-based). Safe for SSE de-dup (last-seq-wins) and lazy lookup.
- Raw payloads live ONLY in the artifact (`.rorca/traces/<runId>.ndjson.gz`), never on the event.
- Every writer op (`start`/`append`/`flush`/`close`) is **nonfatal** — failures disable the writer and log, never throw into story execution.
- Phases reserve room for future surfaces: `context | skill | mcp | memory | prompt`.
- Retention: `pruneExpiredTraceArtifacts(cwd)` bounds local disk; window via `RORCA_TRACE_RETENTION_DAYS` (default 14).

## spec-post-save.ts

Durable post-save orchestration for the explicit-draft persist contract. Manages the enrich → matchSkills dependency chain after `POST /api/specs/persist` seeds a generation log.

```typescript
import {
  buildPersistPostSaveStages,
  enqueuePersistPostSaveJobs,
  advancePersistPostSaveDependencies,
  syncPersistPostSaveStageFromJob,
  getEffectiveGenerationLog,
} from '../lib/spec-post-save';

// Pure logic — build initial stage states from caller options:
const stages = buildPersistPostSaveStages({ enrich: true, matchSkills: true, memorySynthesis: false });
// → enrich: pending/requested_by_caller, matchSkills: pending/requested_by_caller, memorySynthesis: skipped/disabled_by_caller

// Durable enqueue — creates spec_jobs rows + pg-boss messages:
await enqueuePersistPostSaveJobs(specId, workspaceId, { enrich: true, matchSkills: true });
// → enrich: queued immediately, matchSkills: deferred (waitForStage=enrich)

// After enrich job completes — advance deferred dependencies:
await advancePersistPostSaveDependencies(enrichJobId);
// → If enrich succeeded: matchSkills enqueued via pg-boss
// → If enrich failed: matchSkills marked failed/blocked_by_enrich_failure

// Merge persisted stage map with live job statuses:
const effectiveLog = await getEffectiveGenerationLog(specId);
// → Returns generation log with postSaveStages reflecting latest job states
```

**Stage dependency topology**: enrich → matchSkills. matchSkills is deferred (created as a spec_jobs row without pg-boss send) when enrich is also requested. Only enqueued after `advancePersistPostSaveDependencies()` confirms enrich completed.

**Stage status values**: `pending` → `queued` → `running` → `completed` | `failed` | `skipped`. Each transition carries a `PersistStageReason` explaining why (e.g., `durable_job_enqueued`, `waiting_for_enrich`, `blocked_by_enrich_failure`, `no_installed_skills`).

**Repair integration**: `POST /api/specs/:specId/repair` uses `diagnoseSpecHealth()` to check stage states and re-enqueues failed/stuck stages via `enqueueAsyncSpecJob()`.

## Common Mistakes

- **`chatComplete` returns `ChatResult`** — never `const text = await chatComplete(...)` directly. Always `.text`.
- **Model resolution**: check `direction_layers` L3 `preferred_model` first; fall back to default. Already handled in `llm-client.ts` model resolution chain.
- **Schema hydrator is file-based** — it's async (uses `fs.readFile`) but never opens a DB connection.
- **Git hydrator is expensive** — each chunk is an LLM call. Don't call on every request.
- **SSE hub subscribers leak** — `attachSSE()` handles cleanup on disconnect. Don't manually manage subscriber sets outside `sse-hub.ts`.

## Security-Critical Files

- Files matching `backend/src/lib/mcp-*.ts` are security-critical.
- Any change there requires: an explicit security review tag in the PR, an updated threat model section in [CLAUDE.md](/Users/dimitriteravanessian/rorca-feat-rorca-cli-tui-pi-harness/CLAUDE.md), and regression coverage in `backend/src/__tests__/mcp-aegis.test.ts` or the current MCP security test equivalent.
- Root-level context reminder: this scoped [AGENTS.md](/Users/dimitriteravanessian/rorca-feat-rorca-cli-tui-pi-harness/backend/src/lib/AGENTS.md) is valid for local governance and prompt injection, but it does **not** satisfy the workspace health requirement for a root-level `AGENTS.md`.
