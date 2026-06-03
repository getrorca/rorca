# Phase 6 — Pi-native Spec Authoring

Add a safe Pi-native spec authoring flow so users can create specs directly inside Pi.

## Required outcome

- `~/.pi/agent/extensions/rorca/tui/spec-author.ts` exists and is Pi-native.
- `~/.pi/agent/extensions/rorca/index.ts` exposes commands for spec creation inside Pi.
- No direct terminal ownership patterns are introduced.
- The authoring flow can collect at least:
  - title
  - brief
  - story count
  - optional model override
- On success, it should generate a spec and open the spec detail view when possible.

## UX target

- lightweight overlay form or wizard
- keyboard-only operation
- clear submit / cancel behavior
- explicit status while generation is in progress
- clean error reporting

## Done bar

Do not claim done until the command surface exists in code and the validator suite stays green.
