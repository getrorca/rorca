# Master Goal: Redesign the Pi-native Rorca Run View Toward the Screenshot Target

Redesign the Pi-native run cockpit so it feels much closer to the screenshot target the user approved, while remaining fully safe inside Pi.

## Visual target

Primary target: the first screenshot showing a dense story list with clear pass/fail rows, action affordances like `Graph` and `View Log`, plus a structured `RUN INFO` section.

Reference images:
- `/var/folders/85/j8r9g59521l5s07l_987pqyw0000gn/T/clipboard-2026-05-06-200736-0B0BEC36.png`
- `/var/folders/85/j8r9g59521l5s07l_987pqyw0000gn/T/clipboard-2026-05-06-200809-7FAB1CAB.png`

## Non-negotiable constraints

- No nested standalone TUI inside Pi.
- No direct ownership of `process.stdin` in Pi-native views.
- No direct ownership of `process.stdout` in Pi-native views.
- No raw-mode toggling in Pi-native views.
- No terminal reset hacks in Pi-native views.
- Must stay safe under compaction, re-entry, and overlay invalidation.
- Keyboard navigation with arrows and `j/k` must keep working.
- Keep `/rorca:run` Pi-native.

## Full completion target

The redesign is only complete when:
1. `~/.pi/agent/extensions/rorca/tui/run-view.ts` presents a dashboard-like layout closer to the approved screenshot
2. the story list is denser and visually clearer about pass/fail/running state
3. the right side contains structured run info / detail sections, not just a loose text dump
4. affordances for graph/log/detail actions are visible in the UI
5. validators pass repeatedly
6. no known bugs remain
7. the result is implemented in code, not just described
