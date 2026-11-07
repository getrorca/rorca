# Wave 5 — Forgejo Adapter + Oh My Pi Primary Shim — Software Design

## Architecture
The canonical story dependency graph defines the declared delivery topology.

## Components
### W5-001 — Gate the wave on the exact Wave 2/3/4 packets and clean-room evidence
Start W5-002..W5-009 only after the separately merged, independently reviewed Wave 2, Wave 3, Wave 4 packets and the W4-014 real-host clean-room certificates are complete at exact compatible revisions. Wave 5 is sequential; no overlap with another implementation wave is permitted.

**Boundaries**
- No explicit component boundary was declared.

### W5-002 — Register a repository-scoped Forgejo credential with an exact capability probe
Implement a bounded Forgejo credential provider replacing the GitHub App JWT/installation flow with Forgejo-native token authentication: a repository-scoped token (or OAuth2 application credential) bound per workspace, verified by an exact capability probe, never stored raw, and rotatable without rewriting historical identity.

**Boundaries**
- Depends on W5-001

### W5-003 — Serve Forgejo release authority for host-owned draft PR actuation
Mirror the GitHub release-authority seam (backend/src/lib/release-authority.ts + release-identity.ts) over the Forgejo API: host-owned draft pull-request creation, release intents, canonical-PR assertion, quarantine, reconcile, and drain, all under exact per-purpose locks and identity revalidation.

**Boundaries**
- Depends on W5-002

### W5-004 — Project durable Forgejo commit-status and check-run evidence
Mirror the durable Check Run projector (backend/src/lib/check-run-poster.ts) over Forgejo commit statuses (context rorca/pipeline, pending/success/failure, target_url to the run view), driven by the same trusted WAL events with a 30-second reconcile discipline; optionally project Forgejo Actions check runs behind the same interface.

**Boundaries**
- Depends on W5-003

### W5-005 — Bridge host-verified federation results to Forgejo draft PR and status at the exact head
Close the W4-010 residual for Forgejo: a host-verified Wave 4 result proposal (head-exact, changed-path manifest-verified) triggers the release-intent path that projects a Forgejo draft PR and commit status at the exact proposed head. The projection is evidence, not authority.

**Boundaries**
- Depends on W5-004

### W5-006 — Ingest Forgejo webhook events with HMAC verification
Extend the reviewed webhook surface with Forgejo webhooks: HMAC-SHA256 verification (X-Forgejo-Signature and X-Gitea-Signature), exact-path mounting, and pull_request/push/status event ingestion with immutable audit.

**Boundaries**
- Depends on W5-005

### W5-007 — Run the managed executor through Oh My Pi (omp) as the primary shim
Add an OmpManagedExecutor implementing the ROR-28 ExecutionAdapter interface: launch omp (--mode rpc or --print text fallback) with the translated story contract, sanitized environment, capability-snapshot admission, and the same fence/hash evidence discipline as the pi-backed executor.

**Boundaries**
- Depends on W5-001

### W5-008 — Wire the managed continuation controller into production with an omp lane
Activate the built-but-unwired PiManagedContinuationController and NormativeContinuationLane (Wave 3A design surface) in worker/service/routes with an omp continuation lane, and add omp as an execution-engine agent kind beside claude/opencode/codex/pi.

**Boundaries**
- Depends on W5-007

### W5-009 — Verify the rorca extension and skills under omp and reconcile the DMS omp-adapter branch
Make the rorca-pi-extension fully omp-native (omp.extensions/omp.skills manifests), verify all five rorca skills load and run under omp, port the main-only omp provenance tools (rorca_record_subagent_run, rorca_select_workspace, omp-subagent:<agent>) onto the wave branch, and reconcile the user-owned feat/dms-omp-adapter-20260804 branch.

**Boundaries**
- Depends on W5-008

### W5-010 — Conform and certify the adapter against the operator's real Forgejo instance
Operator-owned lane: run conformance, real-host clean-room certification, and a bounded pilot demonstration (federated result -> Forgejo draft PR + commit status at the exact head) against the operator's Forgejo server, mirroring the W4-014 clean-room and W4-010 demo discipline.

**Boundaries**
- Depends on W5-006
- Depends on W5-009

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
