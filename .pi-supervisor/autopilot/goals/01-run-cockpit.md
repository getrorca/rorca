# Phase 1 — Pi-native Run Cockpit

Replace the current unsafe embedded run view path with a real Pi-native run cockpit.

## Required outcome

- `~/.pi/agent/extensions/rorca/tui/run-view.ts` becomes Pi-native and terminal-safe.
- No direct `process.stdin` / `process.stdout` usage in the Pi-native implementation.
- No `setRawMode()` use.
- No manual ANSI painting.
- The view should present useful live run information, not just a placeholder.

## UX target

Aim for a modern cockpit:
- run header and status
- story list / wave awareness
- focused story details or output
- failure visibility
- retry/cancel/log hooks where safe and available
- clean open/close behavior

## Done bar

Do not claim done unless the implementation is real, stable, and validator-clean.
