# Context Injection Per Story Subprocess

### What Every Agent Gets (Universal)

All three agent types (Claude, OpenCode, Codex) receive the same base context layers assembled by `buildPrompt()`. The prompt is constructed in this order:

```
1. Context Preamble (CIE-004)    ← Direction Stack L1/L2/L3 + Memory Ledger
2. OpenCode-specific instruction  ← or Codex-specific instruction
3. Role Section (CIE-006)        ← AGENTS.md file-ownership rules matched to this story
4. Matched Skills (SK-003)       ← .rorca/skills/*.md files (up to 4000 tokens)
5. Graph Block (SW-004)          ← Vector DB: related memories, conventions, file history
6. Persona Section (CA-009)      ← .rorca/personas/<name>.md if story has "persona" field
7. Memory Instructions            ← How to save new memories (differs by agent — see below)
8. ---
9. Your task (story.id):          ← story.description + acceptanceCriteria
```

---

### Layer 1: Context Preamble — Direction Stack + Memory Ledger

The context router writes a temp `.md` file that's read at the start of every prompt. It contains:

| Section | Source | Content |
|---|---|---|
| `RORCA GLOBAL CONTEXT` | L1 (engineering principles) + L2 (domain conventions) | Direction stack globals — priority 101, never dropped |
| `RORCA SCOPED CONTEXT` | L3 (workspace/project-level) | Workspace-specific patterns matched to story file paths via micromatch |
| `RORCA TAGGED CONTEXT` | Story tag matches | Tag-scoped direction rules (e.g., tag: "billing" → billing.md context) |
| `RORCA MEMORY LEDGER` | Last 20 DB memory entries | Timestamped structured rules: Architecture, Convention, Bug Fix, etc. |

**This is the same for all three agents.** The memory ledger (from the DB, not from a vector search — that's a separate layer) is injected here as a flat markdown section.

---

### Layer 2: Knowledge Graph (Vector DB) — SW-004

Separately from the memory ledger above, the execution engine queries the Apache AGE graph DB for context _specifically relevant to this story's predicted file paths_:

- **Related Memories** — past memory entries whose paths overlap with this story
- **Convention Context** — naming what conventions apply to files this story will touch
- **File Touch History** — which other stories previously modified the same files (warns about conflict risk)

This is injected as `=== RELATED HISTORY (from knowledge graph) ===` block. **Same for all three agents.**

> **Caveat**: This only fires if `workspaceId` is set AND `config.includeGraph` is true AND the story mentions file paths that can be predicted. Fails gracefully (warning only).

---

### Layer 3: Skills — SK-003

Skills in `.rorca/skills/*.md` are loaded if the story has a `suggestedSkills` array (set during LLM skill-matching). Token budget is **4000 tokens max** across all injected skills.

**One key difference for Claude**:

```typescript
// Claude-specific: skip .rorca/skills/ entries that already exist in .claude/skills/
// because Claude CLI auto-discovers .claude/skills/*.md natively
if (agentType === 'claude') {
  const claudeSkillPath = path.join(cwd, '.claude', 'skills', `${skill.name}.md`);
  if (fs.existsSync(claudeSkillPath)) continue;  // Skip — Claude gets it automatically
}
```

So for Claude: skills in `.claude/skills/` are injected natively by the CLI — Rorca doesn't double-inject them. Skills that are only in `.rorca/skills/` are injected manually.

For OpenCode/Codex: all matched skills from `.rorca/skills/` are injected into the prompt (no native discovery).

---

### Layer 4: AGENTS.md Role Matching — CIE-006

The engine parses the workspace root `AGENTS.md`, extracts role definitions, and **matches the best role** to each story based on the story's description and acceptance criteria.

If a role matches, the prompt gets a section like:
```markdown
## Agent Role: backend
**Owned files**: server/**/*.ts, routes/**/*.ts
**Avoid files**: frontend/src/**
**Rules**:
  - Always use async/await over .then()
  - Never write raw SQL without parameterization
```

**Same matching logic for all three agents.** What differs is what the agent _does_ with AGENTS.md:

| Agent | What it does with AGENTS.md |
|---|---|
| **Claude** | Role section injected into prompt via `buildPrompt()` |
| **OpenCode** | Role section injected into prompt via `buildPrompt()` |
| **Codex** | Role section injected into prompt via `buildPrompt()` + Codex CLI also auto-discovers the workspace root `AGENTS.md` itself (Codex does native AGENTS.md discovery like Claude does CLAUDE.md) |

For Codex, there's also an explicit instruction added: _"AGENTS.md in the workspace root contains the Rorca direction stack with project standards. Follow its guidance."_ — because Rorca writes the full direction stack INTO `AGENTS.md` before each Codex run (`writeCodexAgentsMd()`), then restores it after.

---

### Layer 5: Memory Save Instructions — The Big Difference

This is the sharpest per-agent split:

| Agent | How memories are saved |
|---|---|
| **Claude** | Instructed to call the `rorca_save_memory` MCP tool (Claude has MCP tool access) |
| **OpenCode** | Instructed to append a JSON object to `.rorca/proposed_memories.json` in the workspace |
| **Codex** | Same as OpenCode — write to `.rorca/proposed_memories.json` |

After the subprocess exits:
- For **Claude**: memories are already in the DB (MCP tool called during the run)
- For **OpenCode/Codex**: the engine reads `.rorca/proposed_memories.json`, ingests each entry into the DB, then rebuilds `MEMORY.md`

Before the next story runs, `writeMemoryMd()` fires to project the current DB state into `MEMORY.md` — so the memory ledger in the next story's context preamble is always up to date.

---

### Layer 6: Personas — CA-009

If the story JSON has a `"persona"` field (e.g., `"persona": "backend"`), the engine looks up `.rorca/personas/backend.md` (or the appropriate category dir), reads it, and injects:

```markdown
## Agent Persona: backend
[full persona prompt text from the file]
```

**Same for all three agents** — no provider-specific handling.

---

### Layer 7: What Claude Gets That Others Don't (Natively)

These are injected by the Claude CLI itself, not by Rorca — so Rorca doesn't add them to the prompt:

| Native to Claude | Where it comes from |
|---|---|
| `CLAUDE.md` content | Auto-injected by `claude --print` from workspace root + parent dirs |
| `.claude/skills/*.md` | Auto-discovered by Claude CLI |
| MCP tool access | `claude --print` inherits MCP config from `~/.claude/` |

This means Claude subprocess sessions are richer by default without Rorca doing extra work.

---

### Summary Matrix

| Context Layer | Claude | OpenCode | Codex |
|---|---|---|---|
| Direction Stack (L1/L2/L3) | ✅ Context router | ✅ Context router | ✅ Context router |
| Memory Ledger (last 20 entries) | ✅ Context router | ✅ Context router | ✅ Context router |
| Vector Graph (related memories/files) | ✅ SW-004 | ✅ SW-004 | ✅ SW-004 |
| AGENTS.md role matching | ✅ Prompt injection | ✅ Prompt injection | ✅ Prompt injection + native discovery |
| Matched skills (.rorca/skills/) | ✅ (skips .claude/skills dupes) | ✅ All matched | ✅ All matched |
| .claude/skills/*.md | ✅ Native (CLI auto-discovers) | ❌ | ❌ |
| .opencode/skills/rorca/SKILL.md | ❌ | ✅ Instructed to read | ❌ |
| CLAUDE.md | ✅ Native (CLI auto-discovers) | ❌ | ❌ |
| AGENTS.md (full direction stack written in) | ❌ | ❌ | ✅ Native + Rorca writes direction stack into it |
| Persona files | ✅ | ✅ | ✅ |
| Memory save | MCP tool call | `.rorca/proposed_memories.json` | `.rorca/proposed_memories.json` |

---

### One Thing to Note About the Vector DB

The "vector DB" (pgvector) isn't used for real-time similarity search on raw embeddings at prompt time in the current implementation — it's accessed through Apache AGE (the graph layer) via `getGraphContext()`. The graph query uses predicted file paths as the anchor, not a semantic embedding of the story. The graph traversal finds memories/conventions/history that are _connected_ to those files in the knowledge graph. This is different from a pure vector cosine search.
