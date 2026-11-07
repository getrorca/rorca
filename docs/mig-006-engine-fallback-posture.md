# MIG-006 Engine Fallback Posture and Dispatch Migration Plan

Status: **enforced after MIG-005 qualification**  
Canonical program spec: [`forge/specs/approved/source-verified-hermes-rorca-omp-ssdlc-delivery-program.json`](../forge/specs/approved/source-verified-hermes-rorca-omp-ssdlc-delivery-program.json) (`MIG-006`)  
Qualification evidence: [`MIG-005 OMP Executor Parity Qualification`](./mig-005-omp-executor-parity-qualification.md)

## Executor posture

Eligible new runs use **OMP by default**. Pi is **fallback-only** and can be selected only by an explicit request, task-manifest, or per-story/spec `agentOverride`. Claude agent compatibility is likewise a deliberate per-story override after OMP qualification.

Pi remains as the residual recovery path because it provides a separately qualified local RPC executor when OMP is unavailable or an operator needs bounded fallback diagnosis. Retaining that path reduces migration rollback risk; it does not grant Pi primary-executor status, platform-based auto-selection, or authority to replace the qualified OMP default.

## Enforcement and durable evidence

- `resolveExecutionOptions()` selects OMP for qualified, otherwise-eligible dispatches and rejects implicit Pi selection from platform, workflow, or active-agent defaults.
- Explicit Pi selection remains available at request, manifest, and spec precedence levels.
- Governed retry reads the parent run's frozen `agent_type` and preserves it through `preserveDeclaredExecutorAcrossRetry()`; it does not re-run default selection.
- Migration `backend/src/db/pg-migrations/20260809120000_engine_fallback_posture.sql` projects the executor decision source and explicit-declaration flag from immutable run trigger options for audit queries.
- `backend/src/lib/__tests__/mig-006-engine-dispatch.node.test.ts` exercises dispatch and retry behavior directly. Documentation-text lint is intentionally not used as a dispatch proxy.

Any future change that makes Pi a default, restores platform/workflow Pi auto-selection, or otherwise expands Pi's primary-executor role reopens the canonical program spec and requires renewed qualification.
