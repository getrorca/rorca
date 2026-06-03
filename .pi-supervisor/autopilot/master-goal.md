# Master Goal: Rebuild the Rorca Pi Extension Safely

Build out the Rorca Pi extension so Pi exposes the new Rorca extension experience instead of the legacy surfaces, while preserving stability and avoiding all known terminal-corruption bugs.

## Non-negotiable constraints

- No nested standalone TUI inside Pi.
- No direct ownership of `process.stdin` in Pi-native views.
- No direct ownership of `process.stdout` in Pi-native views.
- No raw-mode toggling in Pi-native views.
- No terminal reset hacks in Pi-native views.
- Pi-native surfaces must use Pi UI APIs and be safe under compaction/re-entry.
- Unsafe embedded surfaces must remain disabled until their replacements are validated.
- `/rorca-tui` may remain as an external-terminal fallback.

## Full completion target

The extension is only truly complete when:
1. run cockpit is Pi-native and stable
2. board/detail views are Pi-native and stable
3. memory/direction/workspace views are Pi-native and stable
4. command wiring re-enables only validated surfaces
5. validators pass repeatedly
6. reviewer finds no remaining bugs or regressions
7. the result is implemented in code, not just documented
