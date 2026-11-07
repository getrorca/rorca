<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# ADR: Provider-neutral, local-first delivery adapters

- **Status:** Accepted for source implementation; independent review required
- **Date:** 2026-07-28
- **Contract:** `rorca.delivery-adapter.v1`
- **Default adapter:** `local-review-bundle@1.1.0`

## Decision

Delivery is a versioned evidence-projection boundary, not merge or deployment authority. Rorca's canonical default is `LocalReviewBundleAdapter`; it requires no GitHub account, PAT, remote, webhook, network provider, or provider credential. Existing GitHub-specific routes remain intact as **legacy optional delivery surfaces**; Wave 1 does not implement or claim a `GitHubDeliveryAdapter`. Enabling those legacy routes does not change the default and does not grant merge or deployment authority.

`DeliveryAdapter` exposes a descriptor and an authorized `create()` operation. Every descriptor states network, credential, review-bundle, external-change-request, merge-authority, and deployment-authority capabilities. Version 1 hard-codes `mergeAuthority=none` and `deploymentAuthority=none`. External change-request, merge, and deployment actuators stay in their existing separately governed provider/release boundaries.

## Local review bundle authority

A `rorca.local-review-bundle.v1` manifest binds:

- workspace, spec, story, run, attempt, launch generation, and host-attempt envelope;
- canonical spec path, canonical bytes hash, spec/story revisions, and execution-manifest hash;
- opaque exact repository/worktree identities and path digests, run base, attempt base, exact head, and branch;
- changed-file path, status, before/after byte counts and SHA-256 hashes;
- one exact Git patch artifact hash and size (binary changed content fails closed);
- immutable host-attempt, execution-manifest, attempt-result, closeout, validation-receipt, and run-closeout references;
- creation time, adapter contract/version, content hash, bundle ID, and idempotency key; and
- `awaiting_local_review`, `not_authorized` merge/deployment status, and `none` merge/deployment authority.

A bundle may report validation `passed` only when Rorca re-derives an exact successful host attempt, accepted story closeout, exact commit/head, and active non-revoked host validation receipt. Agent prose, PTY content, process exit alone, memory, request-body fields, or bundle creation cannot author pass. A completed attempt lacking that full authority can produce only `blocked` validation; unfinished attempts are rejected.

## Canonical storage and atomic projection

PostgreSQL remains canonical for immutable metadata, idempotency, conflict audit, and host-envelope foreign-key authority:

- `local_review_bundles` is append-only and database-triggered against the exact host attempt;
- `local_review_bundle_conflicts` is append-only changed-replay audit evidence;
- exact `(workspace, adapter, idempotency key)` replay returns the existing row;
- the same key with a different normalized request hash records a bounded conflict and returns `409`; and
- updates and deletes fail at the database boundary.

Artifact bytes are a filesystem projection under `RORCA_DELIVERY_ARTIFACT_ROOT` or the local Rorca data directory. The projection key is `sha256/<prefix>/<content-hash>`. Rorca writes a private staging directory with exclusive/no-follow files, syncs files, atomically renames it to the content address, and then removes write permissions. Existing content is reused only after byte-for-byte verification. Projection finalization and metadata insertion hold one projection advisory lock. A row never points at partially written content. Restart reads re-derive request/content/manifest hashes and row relationships, then re-verify manifest and patch bytes.

Restart maintenance is separate from creation and deliberately non-destructive. Portable Node does not provide a valid descriptor-relative recursive removal primitive, so Rorca does not emulate `openat` with pathname checks and does not automatically chmod, rename, unlink, or recursively remove projection descendants. Maintenance performs bounded no-follow observation under an exact owner-controlled `0700` root, enforces namespace/tree count, depth, ownership, symlink, hard-link, per-file, and total-byte limits, preserves every canonical reference, and records unreferenced projections as retained for explicit operator maintenance. Crash-left `.staging/.bundle-*` trees are handled the same way using non-reversible staging observation identities; attacker-controlled names and paths are not persisted. Historical `planned` deletion actions are restart-reconciled as retained, reference-preserved, or outcome-indeterminate—never guessed as deleted. Historical completed-deletion audits remain immutable evidence, while current maintenance emits no deletion outcome. A database/audit failure can therefore leave only unchanged filesystem bytes, never an unaudited deletion. Referenced artifacts are never changed.

## Filesystem, content, and network safety

The adapter executes local Git object reads only. Its child environment disables credential helpers, prompts, system/global Git configuration, lazy fetch, hooks, external diff, and optional locks. It never invokes fetch, push, `gh`, a provider API, or a remote URL.

Changed paths must be normalized relative Git paths without traversal, backslashes, control characters, secret filenames, `.git`, or empty segments. Symlinks, submodules, unsupported object types, binary content, secret-like content, stale head/branch/worktree identity, and escaped/symlinked artifact roots fail closed. File count, per-file bytes, total changed bytes, patch bytes, manifest bytes, evidence references, and validation receipts are bounded. Raw transcripts, prompts, logs, credentials, provider tokens, and patch bytes are excluded from the public read model.

## API and clients

Safe public reads are:

- `GET /api/delivery/adapters`;
- `GET /api/delivery/review-bundles`; and
- `GET /api/delivery/review-bundles/:bundleId`.

They expose bounded hashes, exact Git identities, counts, local projection integrity, and explicit no-authority state. They do not expose changed paths, raw patch bytes, absolute paths, actors, credentials, or transcripts. This read model is suitable for Rorca, Hermes/MCP, Pi Workbench, and the packaged Pi extension.

`POST /api/delivery/review-bundles` is admin-tier, CSRF-protected, and restricted to the exact local human operator principal. Hosted human creation is truthfully disabled until production bearer authentication exists; injected hosted users and internal services cannot trigger workspace membership reads or cross this boundary. Bounded workspace/run/story/attempt/generation identity and `Idempotency-Key` are validated before authorization middleware; caller evidence, status, paths, validation, merge, deployment, provider, or artifact fields are rejected. Pi Workbench remains read-only rather than guessing a retry identity.

Frontend consumption goes through `apiFetch` and design tokens. Pi's `/rorca-delivery` command is read-only. Public OpenAPI/MCP generation includes reads only; creation is not MCP-exposed.

## Legacy optional GitHub surfaces

No existing GitHub credential, webhook, Check Run, PR, or reviewed-delivery code is removed. Those routes and tests remain provider-specific legacy optional surfaces, not an implementation of the provider-neutral `DeliveryAdapter` interface. They cannot satisfy a local bundle by fallback, and local delivery does not query their state. Any future real `GitHubDeliveryAdapter` requires a separate contract, implementation, and review. Existing provider-human, exact-SHA, merge, and deployment controls remain independently required.

## Integration boundary not included here

The separate branch `spec/context-continuation-retrieval-contract-20260728` (observed local SHA `51df69a6016596df33dc486353620919c2a56c11`) is intentionally not merged into this pivot. A later controlled integration must start from independently reviewed exact SHAs and use this conflict matrix:

| Shared surface | Required integration resolution |
| --- | --- |
| Wave 1 spec and authoring identity | Recompute material hashes; invalidate stale preflight/receipts; preserve every `passes=false`, `approvalReady=false`, and `executionAuthority=none` until governed review. |
| Migrations and authority functions | Rebase in canonical numeric order; rerun all 247+ migrations on a fresh isolated PostgreSQL 16/vector/AGE database. |
| Public contract, OpenAPI, MCP and Pi package | Regenerate from one source tree; compare source, generated, packed, and installed assets byte-for-byte. |
| Context retrieval and delivery authority | Keep context retrieval read-only with respect to delivery; prevent context evidence from becoming host-pass or delivery authority. |
| Workbench/Pi surfaces | Resolve API/type/UI changes without adding create/approve/run/merge/deploy authority. |
| Validation evidence | Discard branch-local completion claims and produce a new exact integrated-source packet plus independent review. |

Neither branch's report is authority to cherry-pick, merge, deploy, reconcile a live run, or reuse stale approval.
