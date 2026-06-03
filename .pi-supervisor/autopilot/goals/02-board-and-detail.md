# Phase 2 — Pi-native Spec Board and Spec Detail

Rebuild the board and spec detail surfaces so they are Pi-native, useful, and terminal-safe.

## Required outcome

- `~/.pi/agent/extensions/rorca/tui/spec-board.ts` is Pi-native and safe.
- `~/.pi/agent/extensions/rorca/tui/spec-detail.ts` is Pi-native and safe.
- No direct `process.stdin` / `process.stdout` usage.
- No raw terminal mode toggling.
- No manual ANSI terminal painting.

## UX target

- board overview that is actually helpful inside Pi
- spec selection / navigation
- spec detail with story visibility and run entry points
- behavior that remains stable when opened/closed repeatedly

## Done bar

Do not claim done until both surfaces are implemented in code and validator-clean.
