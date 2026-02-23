# AGENTS.md — backend/src/lib/

Core service libraries. None are Express routes — they're pure logic called by routes.

## Library Inventory

| File | Purpose |
|------|---------|
| `llm-client.ts` | OpenRouter chat API wrapper. Returns `ChatResult { text, usage }` |
| `sse-hub.ts` | WAL event broadcast to SSE subscribers |
| `direction-stack.ts` | Synthesize all 5 layers into a single context string |
| `schema-hydrator.ts` | Extract CREATE TABLE blocks from migrations/*.sql (no DB connection) |
| `git-hydrator.ts` | LLM map-reduce over git history → memory.yaml |
| `context-extractor.ts` | Multi-source YAML context extraction (file, paste, URL) |
| `spec-writer.ts` | Write generated spec JSON to disk |
| `diagram-generator.ts` | Generate Mermaid + ASCII dep graphs from story list |

## llm-client.ts

```typescript
import { chatComplete } from '../lib/llm-client';

const result = await chatComplete([{ role: 'user', content: prompt }]);
const text = result.text;       // ALWAYS use .text — result is ChatResult, NOT a string
const usage = result.usage;     // { inputTokens, outputTokens }
```

**Supported models** (pass as first arg or use default):
- `claude-sonnet-4-5-20250929`
- `claude-opus-4-6` (default)
- `claude-haiku-4-5-20251001`

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
// Writes to: workspace/scripts/ralph/specs/pending/<slug>.json
```

Creates directories if missing. Overwrites if exists (used on regenerate).

## Common Mistakes

- **`chatComplete` returns `ChatResult`** — never `const text = await chatComplete(...)` directly. Always `.text`.
- **Model resolution**: check `direction_layers` L3 `preferred_model` first; fall back to default. Already handled in `llm-client.ts` model resolution chain.
- **Schema hydrator is sync-ish** — it's async (uses `fs.readFile`) but never opens a DB. No `better-sqlite3` calls inside.
- **Git hydrator is expensive** — each chunk is an LLM call. Don't call on every request.
- **SSE hub subscribers leak** — `attachSSE()` handles cleanup on disconnect. Don't manually manage subscriber sets outside `sse-hub.ts`.
