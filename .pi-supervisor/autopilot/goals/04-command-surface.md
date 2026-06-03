# Phase 4 — Command Surface

Wire the extension command surface so Pi exposes the right commands and only re-enables embedded views that are truly validated.

## Required outcome

- `~/.pi/agent/extensions/rorca/index.ts` routes to the new Pi-native views.
- Unsafe legacy embedded flows remain disabled unless replaced.
- `/rorca-tui` remains an external fallback if needed.
- The extension should favor stable Pi-native UI, not terminal hacks.

## Done bar

Do not claim done until command wiring matches the validated implementation and the validator suite stays green.
