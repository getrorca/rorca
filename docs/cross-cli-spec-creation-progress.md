done:
- Audited current cross-client spec creation surfaces across backend MCP aliases, root AGENTS guidance, Claude project skills, OpenCode project files, and the Pi extension package
- Confirmed the realistic reliability split:
  - explicit command/tool path can be made reliable
  - arbitrary freeform prompt detection cannot be guaranteed 100%
- Added canonical MCP alias `rorca_create_spec` mapped to explicit draft persistence
- Kept `rorca_persist_spec` as a compatibility alias
- Updated MCP tool catalog/docs to present `rorca_create_spec` as the canonical cross-client create-spec name
- Hardened `POST /api/specs/persist` so it seeds `spec_generation_logs` immediately for explicit-draft specs
- The seeded row now makes `GET /api/specs/:specId/generation-log` non-null immediately, even before enrich completes
- Updated root `AGENTS.md` with the preferred explicit spec-creation contract
- Added project-local Claude skill guidance in `.claude/skills/rorca-spec-creation.md`
- Added `docs/cross-cli-spec-creation-plan.md` with a client-by-client matrix for Claude Code / Codex / OpenCode / Pi / generic MCP clients
- Added Pi explicit command `/rorca-create-spec` that dispatches `/skill:rorca-forge` with structured launcher payload
- Kept `/rorca-forge` and `/rorca-forge-run` as legacy/fallback backend-generation wrappers for compatibility
- Updated Pi extension README and skill docs to distinguish preferred skill-first flow from legacy backend generation
- Added/updated coverage for the new MCP alias and Pi command behavior
- Added regression coverage proving persist → immediate generation-log works for the Context tab path
next:
- If desired, add stronger project-local routing/config for OpenCode and Codex once a stable in-repo wrapper/config surface is identified
- Optionally add telemetry showing whether specs were created via explicit tool, skill command, or legacy backend generation
- Optionally migrate more UX surfaces (e.g. TUI forge panel) to explicit draft persistence once a caller-side drafter is available there
decisions:
- Treat explicit create-spec invocation as the only truly reliable cross-client path
- Use `rorca_create_spec` as the canonical cross-client name; keep `rorca_persist_spec` for compatibility
- Do not silently repurpose legacy `/rorca-forge`; add `/rorca-create-spec` as the explicit Pi skill-first entrypoint instead
- Do not claim Codex/OpenCode wrapper-default rewrites were implemented when no clear in-repo wrapper/config surface exists
- Store explicit-draft provenance in `source` + `context_summary_json`, while using allowed `retrieval_method: none` until enrich appends richer retrieval details
files:
- AGENTS.md
- .claude/skills/rorca-spec-creation.md
- backend/src/lib/mcp-http.ts
- backend/src/routes/mcp-tools.ts
- backend/src/routes/specs.ts
- backend/src/routes/__tests__/specs.test.ts
- backend/src/mcp/AGENTS.md
- backend/src/mcp/__tests__/integration.test.ts
- backend/src/mcp/__tests__/persist-spec.test.ts
- docs/cross-cli-spec-creation-plan.md
- docs/cross-cli-spec-creation-progress.md
- /Users/dimitriteravanessian/rorca-feat-rorca-pi-native-execution-runtime-and-embedded-tui-US-003-1777883551065/packages/rorca-pi-extension/extensions/rorca/commands.ts
- /Users/dimitriteravanessian/rorca-feat-rorca-pi-native-execution-runtime-and-embedded-tui-US-003-1777883551065/packages/rorca-pi-extension/extensions/rorca/index.ts
- /Users/dimitriteravanessian/rorca-feat-rorca-pi-native-execution-runtime-and-embedded-tui-US-003-1777883551065/packages/rorca-pi-extension/extensions/rorca/__tests__/commands.test.ts
- /Users/dimitriteravanessian/rorca-feat-rorca-pi-native-execution-runtime-and-embedded-tui-US-003-1777883551065/packages/rorca-pi-extension/skills/rorca-forge/SKILL.md
- /Users/dimitriteravanessian/rorca-feat-rorca-pi-native-execution-runtime-and-embedded-tui-US-003-1777883551065/packages/rorca-pi-extension/README.md
validation:
- cd backend && npx tsc --noEmit --pretty false -> PASSED
- cd backend && npm test -- --runInBand src/mcp/__tests__/persist-spec.test.ts src/mcp/__tests__/integration.test.ts -> PASSED
- cd backend && npm test -- --runInBand src/mcp/__tests__/generate-spec.test.ts src/mcp/__tests__/persist-spec.test.ts src/mcp/__tests__/integration.test.ts -> PASSED
- cd backend && npm test -- --runInBand src/routes/__tests__/specs.test.ts -> PASSED (1 suite, 93 tests)
- cd backend && npm test -- --runInBand src/mcp/__tests__/persist-spec.test.ts src/mcp/__tests__/integration.test.ts -> PASSED (2 suites, 5 tests)
- cd /Users/dimitriteravanessian/rorca-feat-rorca-pi-native-execution-runtime-and-embedded-tui-US-003-1777883551065/packages/rorca-pi-extension && npm run typecheck -> PASSED
- cd /Users/dimitriteravanessian/rorca-feat-rorca-pi-native-execution-runtime-and-embedded-tui-US-003-1777883551065 && npx vitest run --config packages/rorca-pi-extension/vitest.config.ts -> PASSED (5 files, 16 tests)
risks:
- Claude/Codex/OpenCode freeform prompts still depend on model/tool-selection behavior unless the user invokes the explicit tool/command path
- Codex/OpenCode do not yet have a proven in-repo wrapper/default-routing surface equivalent to the Pi command layer
- Pi skill-first create depends on the `rorca-forge` skill being available in the Pi session and on a healthy structured tool path for persistence
- The immediate seeded generation-log row intentionally starts with `retrieval_method: none`; richer retrieval/model context still arrives from later enrich logs rather than the initial persist seed row
