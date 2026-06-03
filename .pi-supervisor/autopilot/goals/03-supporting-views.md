# Phase 3 — Supporting Views

Rebuild the remaining embedded views so they become Pi-native and safe.

## Required outcome

- `~/.pi/agent/extensions/rorca/tui/memory-browser.ts` is Pi-native and safe.
- `~/.pi/agent/extensions/rorca/tui/direction-view.ts` is Pi-native and safe.
- `~/.pi/agent/extensions/rorca/tui/workspace-view.ts` is Pi-native and safe.
- No direct terminal ownership patterns remain in these views.

## UX target

- memory browsing that is readable inside Pi
- direction inspection/edit entry points that do not corrupt Pi
- workspace switching/health visibility that works repeatedly and safely

## Done bar

Do not claim done until all three views are implemented and validator-clean.
