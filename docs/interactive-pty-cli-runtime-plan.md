# Interactive PTY CLI Runtime Plan

## Problem

Rorca's `terminal_mode: "pty"` should show the literal real-time terminal output for agent CLIs. In practice, Pi PTY runs have shown only synthetic Rorca heartbeat text while the agent does useful work silently. That means PTY is not fulfilling its purpose as a faithful live terminal view.

The semantic/ANSI path is useful, but it is not a substitute for PTY. It primarily shows parsed tool/activity events, not the real interactive CLI screen.

## Goal

Make PTY mode work in real time for all supported CLIs:

- Pi
- Claude
- Codex
- OpenCode

PTY mode must mean: launch an interactive CLI under `node-pty`, inject the Rorca prompt like keyboard input, stream every raw terminal byte to the browser immediately, and persist the same bytes for replay.

## Non-goals

- Do not replace the existing non-interactive semantic/ANSI execution path.
- Do not require semantic parsing for PTY correctness.
- Do not rely on synthetic heartbeats as proof of agent activity.
- Do not mark a story passed merely because the agent process exits successfully; story pass remains gated by merge + validation.

## Core Design

Rorca should have two distinct execution modes.

### 1. Semantic / ANSI mode

Used for automation-first runs.

- Launches CLIs in machine-readable or print mode.
- Captures stdout/stderr into `run_output_chunks`.
- Emits parsed `semantic_step` events where available.
- Good for tool streams, token updates, logs, and replay.

Examples:

- `pi --print --mode text ...`
- `claude --print --output-format stream-json ...`
- `opencode run ...`
- `codex exec ...`

### 2. PTY interactive mode

Used for faithful human terminal viewing.

- Launches CLI under `node-pty`.
- Uses interactive CLI mode, not `--print`, RPC, stdin piping, or JSON-only execution.
- Injects the prompt into the PTY as keystrokes/bracketed paste.
- Streams every `pty.onData()` byte directly to clients.
- Persists every byte into `run_pty_output_chunks`.
- Completion is detected via process exit and/or an explicit completion marker.

## Universal PTY Adapter Interface

Add a common PTY adapter abstraction for agent CLIs.

```ts
interface InteractivePtyAgentAdapter {
  agentType: 'pi' | 'claude' | 'codex' | 'opencode';
  resolveCommand(input: PtyLaunchInput): PtyLaunchCommand;
  preparePrompt(input: PtyPromptInput): string;
  injectPrompt(pty: IPty, prompt: string): Promise<void>;
  detectCompletion?(chunk: string, state: PtyCompletionState): PtyCompletionSignal | null;
  cleanup?(state: PtyRunState): Promise<void>;
}
```

The execution engine should use this adapter only when `terminal_mode === "pty"`.

## Prompt Injection

PTY prompt delivery should mimic a human pasting text into a terminal.

Recommended sequence:

1. Spawn the CLI under `node-pty`.
2. Wait for initial render/readiness or a bounded startup delay.
3. Send bracketed paste start: `\x1b[200~`.
4. Write the full prompt text.
5. Send bracketed paste end: `\x1b[201~`.
6. Send Enter: `\r`.

If a CLI does not support bracketed paste reliably, fall back to chunked typing with small delays.

## Completion Detection

Interactive CLIs may not exit automatically after finishing. Rorca needs a deterministic completion strategy.

Use at least one of:

1. **Process exit**: CLI exits with code.
2. **Explicit marker in prompt**: Instruct the agent to print a unique marker when done, e.g.
   `__RORCA_STORY_DONE_<runId>_<storyId>__`.
3. **Marker file**: Instruct the agent to write a file such as
   `.rorca/progress/run-<runId>/<storyId>.done.json`.
4. **Manual/operator timeout fallback**: If no completion signal appears, story remains running/needs intervention.

The marker must not itself imply pass. It only means the agent turn is complete. Rorca still performs merge and validation before setting `passes: true`.

## Streaming Requirements

For PTY mode:

- `pty.onData()` is the source of truth.
- Every chunk must be:
  1. broadcast immediately to live subscribers,
  2. inserted into `run_pty_output_chunks`,
  3. available for late replay through `/api/pipeline/runs/:runId/output`.

Synthetic heartbeat chunks may remain as connection liveness metadata, but they must not be mixed up with agent terminal output or presented as agent activity.

## Frontend Requirements

The run UI should make mode differences explicit.

### Terminal tab

- PTY mode: render raw PTY chunks with xterm.js.
- ANSI mode: render ANSI/log chunks.
- Show a clear badge: `PTY live terminal` vs `ANSI transcript`.

### Semantic tab

- Semantic events are best-effort.
- In PTY mode, semantic parsing may be limited or absent.
- Do not imply that missing semantic events means the run is idle if PTY bytes are flowing.

### Health indicators

Show separate indicators for:

- backend SSE connection alive,
- PTY process alive,
- PTY bytes received recently,
- semantic events received recently,
- agent completion marker seen.

## CLI-specific Launch Strategy

### Pi

PTY command should use interactive text mode.

- Use `pi --mode text` or the closest human-facing non-TUI-safe command.
- Do not use `--print` in PTY mode.
- Do not pipe the prompt through stdin.
- Inject prompt through the PTY.
- Prefer explicit done marker detection.

### Claude

- Use interactive `claude` mode for PTY.
- Do not use `--print` in PTY mode.
- Preserve existing Claude environment stripping rules.
- Inject prompt through the PTY.
- Prefer explicit done marker detection or process exit when reliable.

### Codex

- Use interactive `codex` mode for PTY.
- Do not use `codex exec` for PTY mode.
- Inject prompt through the PTY.
- Prefer explicit done marker detection.

### OpenCode

- Use interactive `opencode` mode or a text-safe interactive mode if available.
- Do not use `opencode run` for PTY mode.
- Inject prompt through the PTY.
- Prefer explicit done marker detection.

## Backend Implementation Steps

1. Add `InteractivePtyAgentAdapter` abstraction.
2. Split execution-engine agent launch into:
   - non-interactive semantic launch path,
   - interactive PTY launch path.
3. Implement Pi PTY adapter first because this is the observed failure.
4. Wire `node-pty.onData()` directly to:
   - SSE live stream,
   - `run_pty_output_chunks`,
   - optional lightweight PTY health timestamps.
5. Implement prompt injection with bracketed paste.
6. Add completion marker generation to `buildPrompt()` only for PTY mode.
7. Detect completion marker in PTY output and/or marker file.
8. Ensure story status remains `running` until completion signal or process exit.
9. Ensure story pass is still gated by integrated merge validation.
10. Add frontend labels/health indicators so operators can distinguish PTY bytes from semantic events.

## Testing Plan

### Unit tests

- Prompt injection writes bracketed paste sequence and Enter.
- PTY chunks are persisted in order.
- PTY replay returns all prior chunks.
- Completion marker detection works across chunk boundaries.
- Heartbeats do not count as agent output.

### Integration tests

Use fake CLI scripts that simulate:

- delayed startup banner,
- incremental terminal output,
- cursor/control sequences,
- done marker split across chunks,
- nonzero exit,
- no-output hang.

Assertions:

- live SSE receives raw chunks in real time,
- DB replay matches live stream bytes,
- story does not pass without validation,
- UI receives PTY metadata correctly.

### Manual smoke tests

For each CLI:

1. Trigger a PTY run.
2. Confirm terminal shows the real CLI banner/output, not only Rorca heartbeats.
3. Confirm prompt appears to be submitted.
4. Confirm live output continues while the agent works.
5. Confirm late browser reload replays the full PTY transcript.
6. Confirm completion transitions correctly.
7. Confirm story pass only after merge + validation.

## Rollout Plan

1. Ship behind a feature flag, e.g. `RORCA_INTERACTIVE_PTY_V2=true`.
2. Enable for Pi only.
3. Validate with one safe story run.
4. Enable for Claude.
5. Enable for Codex.
6. Enable for OpenCode.
7. Remove old Pi PTY prompt-pipe behavior after confidence.

## Acceptance Criteria

PTY mode is considered fixed when:

- A Pi PTY run shows real-time Pi terminal output without relying on synthetic heartbeat text.
- The same output replays after browser refresh.
- Semantic mode still works independently.
- PTY mode works through the same terminal SSE endpoint.
- The agent can complete a story through PTY prompt injection.
- Story pass remains gated by merge + validation.
- The architecture can support Claude, Codex, and OpenCode with adapter-specific launch commands.

## Open Questions

- Which exact interactive command flags should each CLI use to avoid full-screen TUI behavior while preserving real-time text output?
- Should completion markers be printed to terminal, written to files, or both?
- Should PTY mode support live keyboard input from operators during agent execution?
- Should semantic parsing attempt to parse PTY output as a side-channel, or remain disabled by default?
- What timeout policy should apply when the PTY process remains alive but no bytes arrive for a long period?
