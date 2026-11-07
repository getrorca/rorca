# OMP Session Visibility: Resumable Rorca-Run Sessions in the OMP App — Software Design

## Architecture
The canonical dependency diagram below defines the declared delivery topology.

```mermaid
graph LR
  US-001["US-001"]
  US-002["US-002"]
  US-001 --> US-002
```

## Components
### US-001 — Host-side tee of omp RPC sessions into the durable operator store
The sandboxed omp lane writes its session file into the ephemeral per-run runtime dir (deleted at run end), so Rorca-executed sessions never appear in the operator's OMP app. Implement a host-side tee: the engine already reads every JSONL line from the omp RPC child (attachJsonlLineReader on omp stdout); append each line to a durable, omp-compatible session file under ~/.omp/profiles/rorca/agent/sessions/ (operator store), created when the session id is first observed (session_started event), 0600 perms, fsync+close on session end. New module backend/src/lib/omp-session-store.ts (path builder using omp's naming convention '<ISO timestamp with Z and dashes>_<sessionId>.jsonl', open/append/close, idempotent per session); wire into backend/src/lib/execution-engine.ts at the omp RPC JSONL consumption point (~line 4718, where [omp-ui] events are handled). Do not rely on the sandboxed child's runtime session file. The tee must never alter the events forwarded to the run (read-only tee).

**Boundaries**
- No explicit component boundary was declared.

### US-002 — Integration verification and docs for resumable Rorca sessions
Add a node integration test (isolated-jest compatible, like backend/src/lib/__tests__/omp-session-store.node.test.ts) that runs a bounded omp RPC session against the real omp binary with the rorca profile (RORCA_OMP_SANDBOX_QUALIFIED not required for the test; use a temp operator store via env override) and asserts the tee file is written with session events and survives. Document the feature: docs/execution-engine-omp-migration-plan.md gets a short section 'Watching Rorca runs in the OMP app' explaining `omp --profile rorca --resume` to replay/continue any story session, and that sessions are mirrored host-side into the operator store.

**Boundaries**
- Depends on US-001

## Data changes
- No data changes were declared.

## API changes
- No API changes were declared.

## Security and privacy
- No additional security or privacy constraints were declared.

## Migrations
- No migrations were declared.

## Operational concerns
- No additional operational concerns were declared.
