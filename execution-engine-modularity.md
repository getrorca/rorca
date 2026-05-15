# Execution Engine Modularity Review

## Context

This document captures a detailed review of `backend/src/lib/execution-engine.ts` in the Rorca codebase, with a focus on enterprise-grade maintainability, reliability, observability, and developer tooling quality.

The current engine is powerful and feature-rich, but it has evolved into a very large monolithic module with significant operational and architectural risk.

---

## Executive Summary

`execution-engine.ts` currently acts as:

- CLI entrypoint
- config parser
- prompt builder
- agent process manager
- browser MCP orchestrator
- git worktree manager
- wave-based parallel executor
- retry / backoff engine
- token accounting system
- memory synthesis pipeline
- adversarial review runner
- story state mutator
- error classifier
- event emitter / backend synchronizer

That is far too much responsibility for one file.

From an enterprise-grade dev tools perspective, the biggest problems are:

1. **Extreme monolithic size** — the file is over 4,000 lines.
2. **Module-level mutable state** — fragile under concurrency and hard to test.
3. **Repeated synchronous blocking operations** — especially `execSync` and `fs.*Sync` in hot paths.
4. **Inconsistent error handling** — broad `catch` blocks and partial classification logic.
5. **Weak observability structure** — logs are useful but not fully structured or traceable.
6. **Tight coupling** between orchestration concerns that should be isolated.
7. **Shelling out in risky ways** — command construction is not consistently hardened.
8. **Hard-to-test design** — nearly everything is interdependent and stateful.

The engine is functionally sophisticated, but operationally brittle.

---

## What the Engine Does Well

Before recommending changes, it is worth acknowledging the strengths.

### 1. Rich orchestration capability
The engine already supports:

- Claude, OpenCode, and Codex execution
- parallel wave execution
- dependency-aware scheduling
- rate limit retry logic
- fallback engine rerouting
- browser MCP injection
- adversarial review passes
- token accounting and cost calculation
- memory synthesis and projection
- run-state persistence
- git worktree-based isolation

This is not a trivial script. It is a real orchestration system.

### 2. Good operational fallback behavior
There are several thoughtful failover behaviors:

- fallback result files when backend posting fails
- MCP auto-start / auto-restart behavior
- retry loops with backoff
- worktree cleanup helpers
- merge conflict handling with auto-resolution attempts
- recovery of stale spec flags on startup

### 3. Clear intent in comments
The file is heavily annotated and many responsibilities are explained well. That makes the current implementation easier to understand than a typical large “god file.”

### 4. Strong feature coverage
The engine is already trying to solve the actual developer workflow, not just a toy subset of it.

---

## Major Findings

## 1. Monolithic file structure is the primary maintainability issue

The file currently combines too many unrelated concerns. This is the most important structural problem.

### Why this matters
- It increases cognitive load.
- It slows down onboarding.
- It makes unit testing painful.
- It increases regression risk for unrelated features.
- It makes performance tuning harder because responsibilities are entangled.
- It prevents clean reuse of logic elsewhere in the system.

### Enterprise-grade recommendation
Refactor into focused modules with clear boundaries and stable interfaces.

### Proposed modular structure

```text
backend/src/lib/execution-engine/
├── index.ts
├── types.ts
├── config/
│   ├── parse-args.ts
│   ├── engine-config.ts
│   └── validate-spec.ts
├── prompts/
│   ├── prompt-builder.ts
│   ├── role-injection.ts
│   ├── skill-injection.ts
│   ├── graph-context.ts
│   └── memory-instructions.ts
├── agents/
│   ├── agent-router.ts
│   ├── agent-spawner.ts
│   ├── claude-runner.ts
│   ├── opencode-runner.ts
│   ├── codex-runner.ts
│   ├── token-parser.ts
│   ├── error-classifier.ts
│   └── reasoning-env.ts
├── mcp/
│   ├── playwright-mcp.ts
│   ├── chrome-devtools-mcp.ts
│   └── mcp-cleanup.ts
├── execution/
│   ├── story-executor.ts
│   ├── wave-executor.ts
│   ├── concurrency.ts
│   ├── retry-policy.ts
│   └── rate-limit-policy.ts
├── worktrees/
│   ├── worktree-manager.ts
│   ├── merge-orchestrator.ts
│   └── conflict-resolution.ts
├── git/
│   ├── git-commit.ts
│   ├── git-status.ts
│   └── git-utils.ts
├── memory/
│   ├── memory-projector.ts
│   ├── memory-synthesizer.ts
│   └── proposed-memory-ingest.ts
├── reviews/
│   ├── adversarial-review.ts
│   ├── review-parser.ts
│   └── review-prompt.ts
├── telemetry/
│   ├── wal-emitter.ts
│   ├── story-result-client.ts
│   ├── run-state-reporter.ts
│   └── observability.ts
└── orchestration/
    ├── main-loop.ts
    ├── blocked-stories.ts
    ├── resume-context.ts
    └── story-selection.ts
```

### Suggested boundaries

#### `index.ts`
- CLI entrypoint only
- parse args
- bootstrap orchestration
- wire dependencies together

#### `story-executor.ts`
- execute a single story
- no git worktree logic
- no MCP server lifecycle
- no prompt construction beyond accepting a final prompt

#### `agent-spawner.ts`
- spawn agent subprocesses
- stream output
- handle exit codes
- timeout and watchdog behavior
- no story-specific business rules

#### `worktree-manager.ts`
- create, merge, remove, and cleanup worktrees
- manage branch naming strategy
- expose operations via async API

#### `prompt-builder.ts`
- build implementation / QA / journey prompts
- compose role, skill, persona, graph, and memory sections
- pure functions where possible

#### `wave-executor.ts`
- compile and run waves
- bounded concurrency
- dependency blocking
- merge orchestration at wave level

#### `telemetry/*`
- WAL emission
- run-state reporting
- story result posting
- all backend IO abstractions live here

---

## 2. Module-level mutable state is risky

The file currently uses several module-scoped mutable variables:

- `_playwrightMcpServerPid`
- `_playwrightMcpReady`
- `_chromeMcpProxyPid`
- `_chromeMcpReady`
- `_chromeMcpCmd`
- `_chromeMcpArgs`
- `reroutedStories`
- `_fallbackCwd`
- `_fallbackRunId`

### Why this is a problem
- Parallel execution introduces race conditions.
- Cleanup logic depends on hidden global state.
- Testing is brittle because state persists across test cases.
- Reentrancy is poor.
- Future multi-process or worker-thread usage becomes dangerous.

### Recommended fix
Move to an explicit runtime object, for example:

```ts
interface EngineRuntime {
  playwrightMcp?: {
    pid: number | null;
    ready: boolean;
  };
  chromeMcp?: {
    pid: number | null;
    ready: boolean;
    command: string | null;
    args: string[];
  };
  reroutedStories: Map<string, RerouteInfo>;
  fallbackContext?: {
    cwd: string;
    runId: number;
  };
}
```

Then pass this runtime object explicitly to functions that need it.

### Benefit
- Easier testing
- Cleaner lifecycle management
- Better concurrency safety
- No hidden cross-call coupling

---

## 3. Synchronous file and process calls block the event loop

There are many uses of:

- `fs.readFileSync`
- `fs.writeFileSync`
- `fs.existsSync`
- `execSync`

### Why this is a problem
In a high-concurrency orchestration engine, blocking the event loop can:

- degrade throughput
- delay task scheduling
- worsen responsiveness
- make timeouts less predictable
- create tail latency spikes during wave execution

### Recommended fix
Use async equivalents where possible:

- `fs.promises.readFile`
- `fs.promises.writeFile`
- `fs.promises.access`
- `spawn`/`execFile` instead of `execSync`

For git operations, prefer a thin async wrapper around `spawn`/`execFile` with controlled environment and timeouts.

### Where sync calls are acceptable
A few startup-only calls can remain synchronous if they are truly one-time bootstrapping. But they should be minimized and isolated.

---

## 4. Error handling is inconsistent and often too broad

There are many `catch {}` and `catch (err: any)` blocks that swallow useful detail.

### Risks
- Silent failure modes
- Loss of debugging context
- Inability to differentiate recoverable vs non-recoverable errors
- Hidden regressions

### Recommended fix
Use a consistent error policy:

1. Catch `unknown` instead of `any`
2. Narrow error types before using them
3. Log with structured context
4. Only swallow errors when the fallback is deliberate and documented

### Example pattern

```ts
catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn({ err: message, storyId }, 'Non-fatal failure during X');
}
```

### Add error categories beyond OpenCode
Right now OpenCode gets a rich classifier, but Claude and Codex are mostly treated generically. Enterprise-grade tooling should classify failures consistently across providers:

- authentication/config errors
- model availability errors
- rate limit errors
- timeout errors
- transport errors
- malformed output errors
- tool integration errors

---

## 5. There is no circuit breaker for failing providers or backend services

The engine retries and backs off, but it does not open a circuit when an upstream is clearly unhealthy.

### Why this matters
Without a circuit breaker, the engine can:

- repeatedly hammer a failing LLM provider
- spam backend APIs during outages
- amplify failure load
- waste run time and money

### Recommended fix
Add a circuit breaker policy with states such as:

- closed
- open
- half-open

Use it for:

- agent providers
- backend WAL posting
- story-result posting
- memory API calls
- MCP startup probes if they repeatedly fail

---

## 6. Observability is good, but not enterprise-grade yet

The engine logs a lot, but the logging model is not fully structured or trace-aware.

### Current issues
- mixed `logger.info`, `process.stdout.write`, `console.warn`
- no correlation IDs across story execution
- no unified trace span model
- backend event emission and local logs are not joined together

### Recommended fix
Adopt structured logging + trace context.

#### Add fields like:
- `runId`
- `workspaceId`
- `specId`
- `storyId`
- `waveIndex`
- `agentType`
- `model`
- `attempt`
- `worktreePath`
- `branchName`

#### Suggested improvements
- Use a single logger abstraction everywhere
- Emit JSON logs in addition to human-readable logs if needed
- Add OpenTelemetry spans around:
  - story execution
  - git worktree lifecycle
  - agent process runs
  - backend posts
  - merge phases

### Benefit
- Easier support/debugging
- Better production diagnosis
- Better timing and latency analysis
- Cleaner integration with enterprise dashboards

---

## 7. Process management can be hardened

The engine spawns external programs extensively:

- Claude CLI
- OpenCode
- Codex
- `npx @playwright/mcp`
- Chrome DevTools MCP
- git commands

### Risks
- zombie processes
- orphaned child processes
- incomplete cleanup after crashes
- hard-to-debug hung subprocesses
- no process group management

### Recommended fix
Create a standardized process runner:

- spawn process
- attach stdout/stderr handlers
- create watchdog
- support cancellation
- kill process group on termination
- return structured result object

### Additional hardening
- use process groups where supported
- ensure cleanup on SIGINT, SIGTERM, uncaughtException, unhandledRejection
- always close streams and remove temp files in `finally`

---

## 8. Shell command construction should be hardened

The engine shells out to git and other tools using interpolated command strings in a number of places.

### Risk
- command injection if any user-controlled string is not adequately sanitized
- quoting issues on different platforms
- maintenance burden

### Recommended fix
Prefer argument arrays via `spawn`/`execFile` over shell strings.

#### Example
Instead of:
```ts
execSync(`git commit -m "${message}"`, ...)
```
Use:
```ts
spawn('git', ['commit', '-m', message], ...)
```

### Where shell strings remain acceptable
Only when absolutely necessary and after strict sanitization, but the long-term goal should be to eliminate them.

---

## 9. Testing is currently too difficult

Because the file is tightly coupled and stateful, tests are hard to isolate.

### Problems
- globals leak between tests
- many functions have side effects
- subprocess behavior is deeply embedded
- file system and network are mixed into business logic
- large integration surface with little seam separation

### Recommended fix
Refactor for dependency injection.

#### Inject abstractions for:
- file system operations
- process spawning
- logger
- backend client
- git client
- MCP server lifecycle
- memory projection
- config loader

### Test layers to create
1. **Unit tests** for pure helpers
   - prompt composition
   - classification
   - path extraction
   - wave blocking logic
2. **Integration tests** for agent runners
   - spawn logic
   - timeout behavior
   - retry handling
3. **End-to-end tests** for orchestration
   - wave execution
   - merge outcomes
   - fallback behavior

### Result
You get fast, focused tests instead of brittle full-stack checks for every change.

---

## 10. Config and schema validation should be stronger

The engine accepts a large JSON spec with many optional behaviors.

### Risk
- bad input shape can lead to runtime errors
- behavior depends on implicit defaults
- malformed spec variants are not always caught early

### Recommended fix
Introduce runtime validation with a schema library such as Zod or Valibot.

Validate:
- story IDs
- agent types
- model names
- boolean override fields
- timeout values
- merge strategies
- reasoning config
- browser MCP flags
- dependencies

### Benefit
- fail fast at the boundary
- clearer error messages
- less defensive code inside the engine

---

## 11. Memory, review, and telemetry responsibilities should be separated

The engine currently handles:

- memory projection
- proposed memory ingestion
- adversarial review
- review output parsing
- result posting
- WAL event emission

These are each meaningful subsystems.

### Recommendation
Split them into independently testable modules.

#### Memory subsystem
- build story summary
- read tail logs
- project MEMORY.md
- ingest proposed memories

#### Review subsystem
- build review prompt
- parse review output
- store comments
- apply blockers

#### Telemetry subsystem
- emit WAL events
- emit story-result posts
- manage fallback output files
- track run-state events

### Benefit
- cleaner dependencies
- easier future expansion
- more reliable error handling

---

## 12. Wave execution and merge logic need clearer transactional semantics

Parallel execution plus git merging is sophisticated but fragile.

### Current concerns
- many moving parts in one control flow
- merge decisions are interwoven with execution state mutation
- failure semantics are not fully isolated
- cleanup behavior is complex

### Recommended fix
Model wave execution like a transaction pipeline:

1. plan worktrees
2. execute stories
3. validate per-story outcome
4. merge clean stories
5. resolve conflicts
6. persist story status
7. clean up or preserve failed branches

Each phase should have clearly defined input/output contracts.

### Benefit
- easier to reason about partial failure
- simpler recovery and resume behavior
- reduced merge-state bugs

---

## Proposed Refactor Phases

A rewrite should not be done all at once. This should be incremental.

### Phase 1 — Extract pure helpers
Move low-risk pure utilities first:
- story text builders
- signal detection
- token estimation helpers
- model normalization
- error classification
- blocked-story computation
- review parsing

### Phase 2 — Extract process runners
Move agent execution into dedicated modules:
- Claude runner
- OpenCode runner
- Codex runner
- shared watchdog / timeout logic

### Phase 3 — Extract orchestration services
- story executor
- wave executor
- worktree manager
- merge orchestrator

### Phase 4 — Extract telemetry and memory subsystems
- WAL emitter
- story result client
- memory projector
- adversarial review pipeline

### Phase 5 — Replace globals with runtime state
Pass an explicit runtime/context object through the execution stack.

---

## Suggested API boundaries

### `StoryExecutionContext`
Contains per-story values:
- story
- mode
- cwd
- workspaceId
- runId
- agent/model selection
- prompt path
- log file path
- worktree info
- browser MCP URLs
- graph context

### `EngineRuntime`
Contains run-scoped state:
- reroute map
- fallback context
- MCP server lifecycle data
- cleanup handlers
- feature flags

### `StoryExecutionResult`
Contains story outcome:
- pass/fail/skipped
- exit code
- token usage
- cost
- emitted events
- review results
- merge result

This makes the engine much easier to evolve.

---

## What I Would Improve First

If I were leading this as an enterprise dev tools codebase, I would prioritize:

1. **Split the file into modules**
2. **Remove module-level mutable state**
3. **Create a shared process runner abstraction**
4. **Add schema validation**
5. **Standardize structured logging**
6. **Add a circuit breaker**
7. **Replace shell-string git commands with argument arrays**
8. **Refactor the story executor into a service class or orchestration function**
9. **Increase unit test coverage around pure helper functions**
10. **Add tracing/observability context**

---

## Final Assessment

This engine is **impressive but overextended**.

It has the logic and ambition of an enterprise orchestration system, but it currently lives in a form that is too coupled, too large, and too stateful to scale comfortably.

The biggest opportunity is not adding more features — it is **creating modular boundaries** so the existing features become reliable, testable, and easier to evolve.

If you want, I can turn this into a **concrete refactor plan with phases, file names, and task breakdowns** next.
