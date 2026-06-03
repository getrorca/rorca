# Phase 7 — Run View Redesign

Redesign `~/.pi/agent/extensions/rorca/tui/run-view.ts` so the running-spec experience is much closer to the approved screenshot target.

## Reference images

- `/var/folders/85/j8r9g59521l5s07l_987pqyw0000gn/T/clipboard-2026-05-06-200736-0B0BEC36.png`
- `/var/folders/85/j8r9g59521l5s07l_987pqyw0000gn/T/clipboard-2026-05-06-200809-7FAB1CAB.png`

## UX target

Prioritize the first screenshot.

Desired qualities:
- dense story list
- clearer pass / fail / running rows
- stronger selected-row highlight
- visible action affordances like `Graph` and `View Log`
- structured `RUN INFO` section
- more dashboard-like right pane
- less prose, more compact operational layout

## Constraints

- Keep the view Pi-native and terminal-safe.
- Keep the current safe overlay / custom UI approach.
- Preserve keyboard navigation.
- Avoid regressions in refresh, invalidation, and cleanup.

## Done bar

Do not claim done until:
- the run view has visibly moved toward the screenshot target in code structure and labels
- `scripts/validate_rorca_runview_target.py` passes
- TypeScript passes
- `scripts/validate_rorca_pi_extension.py` stays green
