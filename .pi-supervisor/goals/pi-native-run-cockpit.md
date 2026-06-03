# Goal: Pi-native Run Cockpit

Build a state-of-the-art Pi-native run cockpit for the Rorca Pi extension.

## Product intent

When a spec is running, Pi should provide a first-class run monitoring experience inside Pi itself, not a raw terminal hack and not a nested TUI that corrupts Pi.

The target experience is a reliable run cockpit with:
- live run status
- wave / DAG progress
- per-story state
- focused-story output pane
- failure summaries
- retry / cancel / logs / graph actions
- clean open/close behavior with no terminal corruption

## Hard technical rules

- No direct ownership of `process.stdin` for Pi-native views.
- No direct ownership of `process.stdout` for Pi-native views.
- No raw terminal mode toggling inside Pi-native views.
- No terminal reset hacks in Pi-native surfaces.
- Use Pi custom UI APIs only (`ctx.ui.custom()` and Pi TUI primitives).
- Keep the current unsafe embedded views disabled until the replacement is validated.

## Delivery strategy

1. Build the Pi-native run view first.
2. Make it stable and validated.
3. Only then consider rebuilding spec detail and board around it.

## Definition of done

- A Pi-native run cockpit implementation exists in code.
- The implementation is compaction-safe and terminal-safe.
- Configured validators pass.
- The handoff reports zero known bugs.
- The implementation is not just a plan or placeholder.
