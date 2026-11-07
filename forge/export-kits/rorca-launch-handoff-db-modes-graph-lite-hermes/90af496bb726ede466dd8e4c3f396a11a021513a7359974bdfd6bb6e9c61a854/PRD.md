# Rorca Launch Handoff: DB Modes, Graph Lite, and Hermes — Product Requirements

## Problem
Deliver the behavior defined by the canonical Rorca Launch Handoff: DB Modes, Graph Lite, and Hermes specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- LHM-001 — Add a canonical database capability model and redacted runtime status surface
- LHM-002 — Implement BYOP database handling for Supabase and other hosted Postgres providers
- LHM-003 — Add Graph Lite providers and graceful fallback behavior
- LHM-004 — Update Knowledge Graph and health UI to be honest in full and lite modes
- LHM-005 — Add explicit DB mode selection UX for onboarding and settings
- LHM-006 — Package Hermes skills and verify MCP discovery against the real Rorca tool surface
- LHM-007 — Truth-align launch docs, install paths, and deployment guidance
- LHM-008 — Lock the capability layer with regression tests and Miguel boundary checks
- LHM-009 — Require pgvector for every PostgreSQL install path

## In scope
- Introduce a single source of truth for database mode, provider, extension support, warnings, and graph capability so the rest of Rorca can reason about native local Postgres, Docker Postgres with AGE, and BYOP hosted Postgres consistently while also finishing any remaining gaps in Miguel’s setup/bootstrap work with the minimum necessary changes.
- Allow users to provide, validate, and persist their own PostgreSQL connection string and switch into byop mode for Supabase, Neon, and similar providers without relying on local Docker or native bootstrap logic.
- Create a graph abstraction that uses Apache AGE for full mode and relational or semantic fallback logic for Graph Lite when AGE is unavailable, so hosted BYOP providers still have useful graph-related features.
- Expose database mode and graph capability in the UI so users understand whether they are in full graph, Graph Lite, or disabled mode, and keep dependency, relevance, and memory views useful in degraded states.
- Provide a clear user-facing path to choose native managed Postgres, Docker Postgres with AGE, or BYOP hosted Postgres during first install/setup and later in settings, while reflecting the completed native/Docker setup path rather than a half-finished bootstrap flow.
- Make Rorca usable from Hermes by packaging the skills, documenting the install/update path, and verifying that Hermes can register and discover the current Rorca MCP surface without overclaiming unsupported features.
- Update the user-facing docs and launch scripts so README, Quickstart, Supabase, MCP, install, and Helm guidance match the real implementation and either validate or remove broken claims.
- Add focused backend, frontend, and extension coverage proving that mode detection, Graph Lite fallback, UI honesty, Hermes discovery, and BYOP handling work correctly while finishing and protecting Miguel’s full-graph setup path end-to-end.
- Validate that native/local Postgres, Docker Postgres with AGE, and BYOP hosted Postgres such as Supabase or Neon all have pgvector available before the setup is accepted, and surface a clear fix path when it is missing.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### LHM-001
Introduce a single source of truth for database mode, provider, extension support, warnings, and graph capability so the rest of Rorca can reason about native local Postgres, Docker Postgres with AGE, and BYOP hosted Postgres consistently while also finishing any remaining gaps in Miguel’s setup/bootstrap work with the minimum necessary changes.

**Acceptance criteria**
- A canonical capability object exists with dbMode, provider, extensions, graphMode, and warnings fields.
- AGE availability is detected through one shared helper and is not re-probed ad hoc by UI components or individual routes.
- A health or status API surface exposes the capability model for frontend and operator use.
- Any DB URL or connection metadata shown by the status surface is redacted so no secrets appear in logs, toasts, API responses, or UI.
- Capability output includes enough guidance for the UI to distinguish full, lite, and disabled graph support without guessing.
- Native, Docker, and BYOP modes are distinguished, and any remaining gaps in Miguel-owned DB startup, sidecar, or bootstrap lifecycle code are completed with the minimum necessary changes rather than a rewrite.

### LHM-002
Allow users to provide, validate, and persist their own PostgreSQL connection string and switch into byop mode for Supabase, Neon, and similar providers without relying on local Docker or native bootstrap logic.

**Acceptance criteria**
- Users can supply a hosted PostgreSQL DATABASE_URL and persist it as byop mode.
- Connection strings are validated safely and clearly malformed or unsafe values are rejected before persistence.
- Supabase, Neon, and other remote Postgres providers are treated as byop rather than native or docker whenever the capability model can identify them.
- Switching back from byop to native or docker does not leave stale settings that break startup or cause the wrong mode to be reported.
- The app can validate a BYOP connection without printing passwords, tokens, or other secrets in responses or logs.
- The app rejects a BYOP PostgreSQL connection unless the server has the pgvector extension installed and usable for the selected database mode.
- The flow does not depend on local DB bootstrap, and any new route or setting surface is annotated with the correct Swagger tier/rationale if exposed publicly.

### LHM-003
Create a graph abstraction that uses Apache AGE for full mode and relational or semantic fallback logic for Graph Lite when AGE is unavailable, so hosted BYOP providers still have useful graph-related features.

**Acceptance criteria**
- Graph mode is selected from the runtime capability model, not hardcoded per route or component.
- When AGE is available, existing full graph behavior remains intact for graph surfaces that already depend on it and the native/Docker full-graph setup is complete end-to-end.
- When AGE is unavailable, graph-facing features use a relational or semantic fallback instead of failing outright wherever practical.
- Fallback behavior is consistent across memory graph, knowledge graph, and spec relevance graph surfaces.
- Story dependency graphs remain functional in every supported DB mode and do not regress when Graph Lite is enabled.
- AGE-only admin operations remain gated or clearly unavailable in lite mode, and product-facing routes do not present opaque 503-style failures.

### LHM-004
Expose database mode and graph capability in the UI so users understand whether they are in full graph, Graph Lite, or disabled mode, and keep dependency, relevance, and memory views useful in degraded states.

**Acceptance criteria**
- Settings or health surfaces show the selected DB mode and graphMode clearly.
- Knowledge Graph-related panels show a non-scary Graph Lite banner when AGE is unavailable.
- Full graph views continue to work unchanged for native and Docker AGE setups.
- Lite mode shows useful fallback data or empty states instead of opaque failure UX wherever possible.
- UI copy explains how to get Full Graph back by switching to local or Docker Postgres with AGE.
- Frontend API calls continue to go through src/lib/apiFetch, and the UI uses design tokens rather than hardcoded hex values.
- Fallback messaging distinguishes between unavailable graph capability and an actual backend failure.

### LHM-005
Provide a clear user-facing path to choose native managed Postgres, Docker Postgres with AGE, or BYOP hosted Postgres during first install/setup and later in settings, while reflecting the completed native/Docker setup path rather than a half-finished bootstrap flow.

**Acceptance criteria**
- First install/onboarding explicitly asks the user which database mode they want to use before starting DB bootstrap or connection validation.
- Users can choose among native, docker, and byop modes from a discoverable UI surface.
- Each selectable mode links to or embeds a mode-specific startup guide: native/local Postgres, Docker Postgres with AGE, and BYOP hosted Postgres such as Supabase or Neon.
- The UI explains the tradeoffs between Full Graph and Graph Lite modes before the user commits.
- The selected mode is persisted and reflected in the next startup or session.
- The onboarding path can prefill sensible defaults without forcing users through hidden bootstrap behavior.
- If a BYOP connection is chosen, the UI guides the user to the right secret-safe connection input and validation flow.
- The UX does not force a rewrite of Miguel’s setup work; if a small adapter is needed to complete the mode-selection path, it is included in this spec.

### LHM-006
Make Rorca usable from Hermes by packaging the skills, documenting the install/update path, and verifying that Hermes can register and discover the current Rorca MCP surface without overclaiming unsupported features.

**Acceptance criteria**
- The Hermes-facing skills reference the correct MCP server and the current tool names rather than stale aliases.
- A documented install or update flow exists for the Rorca skills and can be followed in a clean environment.
- Hermes can register the Rorca MCP server and discover the intended tools, including create-spec, get-context, list/approve specs, and pipeline trigger/status surfaces.
- The skill docs teach the intended brief → spec → review → approve → run → inspect workflow and avoid promising unsupported behavior.
- The Hermes docs remain truthful about Graph Lite, BYOP, and the fact that Hermes is an external distribution channel rather than a replacement for first-party Rorca UX.
- Any published skill package or release artifact is versioned so updates can be validated and rolled back cleanly.

### LHM-007
Update the user-facing docs and launch scripts so README, Quickstart, Supabase, MCP, install, and Helm guidance match the real implementation and either validate or remove broken claims.

**Acceptance criteria**
- README, QUICKSTART, docs/supabase-setup.md, docs/mcp-integration.md, and related launch docs accurately describe native, Docker, and BYOP modes.
- The install/setup docs include a clear chooser-oriented startup guide for each supported database path: native/local Postgres, Docker Postgres with AGE, and BYOP hosted Postgres such as Supabase or Neon.
- Any install or deployment path that remains in the docs is verified by a working command or is removed from the launch story until it is fixed.
- Supabase is documented as BYOP, not as a full-graph replacement for AGE-backed local or Docker setups.
- Docs explicitly explain Graph Lite and how to get Full Graph back.
- Launch docs do not overclaim about Docker, Helm, or install.sh behavior, and they do not imply SQLite or PGlite are in launch scope.
- Where docs show commands, the commands are internally consistent with the current repo layout and current package/tool names.

### LHM-008
Add focused backend, frontend, and extension coverage proving that mode detection, Graph Lite fallback, UI honesty, Hermes discovery, and BYOP handling work correctly while finishing and protecting Miguel’s full-graph setup path end-to-end.

**Acceptance criteria**
- Tests cover native, docker, and byop detection plus persisted mode behavior.
- Tests cover AGE present versus absent and the resulting graphMode.
- Fallback behavior is covered for at least one knowledge graph surface and one memory or relevance surface.
- UI and status tests verify that Graph Lite copy appears when AGE is missing and that secrets remain redacted.
- Existing local/Docker full-graph startup behavior continues to pass, and any previously incomplete setup gaps in Miguel’s path are closed by this spec rather than deferred.
- Regression tests ensure Miguel’s db-sidecar, bootstrap, and Docker image lifecycle behavior are not altered by this spec.

### LHM-009
Validate that native/local Postgres, Docker Postgres with AGE, and BYOP hosted Postgres such as Supabase or Neon all have pgvector available before the setup is accepted, and surface a clear fix path when it is missing.

**Acceptance criteria**
- Native/local startup checks for pgvector explicitly and tells the user how to enable or install it before declaring the setup successful.
- Docker startup verifies pgvector is present in the Rorca PostgreSQL image or bootstrap step before the Docker path is marked ready.
- BYOP validation rejects Supabase/Neon-style PostgreSQL connections that do not have pgvector and explains how to fix the hosted database before proceeding.
- The pgvector check keeps secrets redacted and does not change the existing native, Docker, or BYOP mode selection flow.

## Success metrics
- LHM-001: A canonical capability object exists with dbMode, provider, extensions, graphMode, and warnings fields.
- LHM-001: AGE availability is detected through one shared helper and is not re-probed ad hoc by UI components or individual routes.
- LHM-001: A health or status API surface exposes the capability model for frontend and operator use.
- LHM-001: Any DB URL or connection metadata shown by the status surface is redacted so no secrets appear in logs, toasts, API responses, or UI.
- LHM-001: Capability output includes enough guidance for the UI to distinguish full, lite, and disabled graph support without guessing.
- LHM-001: Native, Docker, and BYOP modes are distinguished, and any remaining gaps in Miguel-owned DB startup, sidecar, or bootstrap lifecycle code are completed with the minimum necessary changes rather than a rewrite.
- LHM-002: Users can supply a hosted PostgreSQL DATABASE_URL and persist it as byop mode.
- LHM-002: Connection strings are validated safely and clearly malformed or unsafe values are rejected before persistence.
- LHM-002: Supabase, Neon, and other remote Postgres providers are treated as byop rather than native or docker whenever the capability model can identify them.
- LHM-002: Switching back from byop to native or docker does not leave stale settings that break startup or cause the wrong mode to be reported.
- LHM-002: The app can validate a BYOP connection without printing passwords, tokens, or other secrets in responses or logs.
- LHM-002: The app rejects a BYOP PostgreSQL connection unless the server has the pgvector extension installed and usable for the selected database mode.
- LHM-002: The flow does not depend on local DB bootstrap, and any new route or setting surface is annotated with the correct Swagger tier/rationale if exposed publicly.
- LHM-003: Graph mode is selected from the runtime capability model, not hardcoded per route or component.
- LHM-003: When AGE is available, existing full graph behavior remains intact for graph surfaces that already depend on it and the native/Docker full-graph setup is complete end-to-end.
- LHM-003: When AGE is unavailable, graph-facing features use a relational or semantic fallback instead of failing outright wherever practical.
- LHM-003: Fallback behavior is consistent across memory graph, knowledge graph, and spec relevance graph surfaces.
- LHM-003: Story dependency graphs remain functional in every supported DB mode and do not regress when Graph Lite is enabled.
- LHM-003: AGE-only admin operations remain gated or clearly unavailable in lite mode, and product-facing routes do not present opaque 503-style failures.
- LHM-004: Settings or health surfaces show the selected DB mode and graphMode clearly.
- LHM-004: Knowledge Graph-related panels show a non-scary Graph Lite banner when AGE is unavailable.
- LHM-004: Full graph views continue to work unchanged for native and Docker AGE setups.
- LHM-004: Lite mode shows useful fallback data or empty states instead of opaque failure UX wherever possible.
- LHM-004: UI copy explains how to get Full Graph back by switching to local or Docker Postgres with AGE.
- LHM-004: Frontend API calls continue to go through src/lib/apiFetch, and the UI uses design tokens rather than hardcoded hex values.
- LHM-004: Fallback messaging distinguishes between unavailable graph capability and an actual backend failure.
- LHM-005: First install/onboarding explicitly asks the user which database mode they want to use before starting DB bootstrap or connection validation.
- LHM-005: Users can choose among native, docker, and byop modes from a discoverable UI surface.
- LHM-005: Each selectable mode links to or embeds a mode-specific startup guide: native/local Postgres, Docker Postgres with AGE, and BYOP hosted Postgres such as Supabase or Neon.
- LHM-005: The UI explains the tradeoffs between Full Graph and Graph Lite modes before the user commits.
- LHM-005: The selected mode is persisted and reflected in the next startup or session.
- LHM-005: The onboarding path can prefill sensible defaults without forcing users through hidden bootstrap behavior.
- LHM-005: If a BYOP connection is chosen, the UI guides the user to the right secret-safe connection input and validation flow.
- LHM-005: The UX does not force a rewrite of Miguel’s setup work; if a small adapter is needed to complete the mode-selection path, it is included in this spec.
- LHM-006: The Hermes-facing skills reference the correct MCP server and the current tool names rather than stale aliases.
- LHM-006: A documented install or update flow exists for the Rorca skills and can be followed in a clean environment.
- LHM-006: Hermes can register the Rorca MCP server and discover the intended tools, including create-spec, get-context, list/approve specs, and pipeline trigger/status surfaces.
- LHM-006: The skill docs teach the intended brief → spec → review → approve → run → inspect workflow and avoid promising unsupported behavior.
- LHM-006: The Hermes docs remain truthful about Graph Lite, BYOP, and the fact that Hermes is an external distribution channel rather than a replacement for first-party Rorca UX.
- LHM-006: Any published skill package or release artifact is versioned so updates can be validated and rolled back cleanly.
- LHM-007: README, QUICKSTART, docs/supabase-setup.md, docs/mcp-integration.md, and related launch docs accurately describe native, Docker, and BYOP modes.
- LHM-007: The install/setup docs include a clear chooser-oriented startup guide for each supported database path: native/local Postgres, Docker Postgres with AGE, and BYOP hosted Postgres such as Supabase or Neon.
- LHM-007: Any install or deployment path that remains in the docs is verified by a working command or is removed from the launch story until it is fixed.
- LHM-007: Supabase is documented as BYOP, not as a full-graph replacement for AGE-backed local or Docker setups.
- LHM-007: Docs explicitly explain Graph Lite and how to get Full Graph back.
- LHM-007: Launch docs do not overclaim about Docker, Helm, or install.sh behavior, and they do not imply SQLite or PGlite are in launch scope.
- LHM-007: Where docs show commands, the commands are internally consistent with the current repo layout and current package/tool names.
- LHM-008: Tests cover native, docker, and byop detection plus persisted mode behavior.
- LHM-008: Tests cover AGE present versus absent and the resulting graphMode.
- LHM-008: Fallback behavior is covered for at least one knowledge graph surface and one memory or relevance surface.
- LHM-008: UI and status tests verify that Graph Lite copy appears when AGE is missing and that secrets remain redacted.
- LHM-008: Existing local/Docker full-graph startup behavior continues to pass, and any previously incomplete setup gaps in Miguel’s path are closed by this spec rather than deferred.
- LHM-008: Regression tests ensure Miguel’s db-sidecar, bootstrap, and Docker image lifecycle behavior are not altered by this spec.
- LHM-009: Native/local startup checks for pgvector explicitly and tells the user how to enable or install it before declaring the setup successful.
- LHM-009: Docker startup verifies pgvector is present in the Rorca PostgreSQL image or bootstrap step before the Docker path is marked ready.
- LHM-009: BYOP validation rejects Supabase/Neon-style PostgreSQL connections that do not have pgvector and explains how to fix the hosted database before proceeding.
- LHM-009: The pgvector check keeps secrets redacted and does not change the existing native, Docker, or BYOP mode selection flow.

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

