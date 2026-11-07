# Bounty REST Controller operation matrix

`/api/bounty` is a credential-authenticated human-administrator adapter. Global authentication, CSRF, rate limiting, and plan gating run before the router; each Controller query also binds `workspaceId + programId + missionId`. All operations are `admin` tier and explicitly excluded from MCP, Pi, and Hermes.

| Method | Operation ID | Purpose | Tier | MCP | Pi | Hermes | Raw-data policy |
|---|---|---|---|---:|---:|---:|---|
| POST `/api/bounty/admissions` | `admitBountyProgram` | Admit one bounded program scope | admin | No | No | No | Validated scope only; no evidence or credentials |
| POST `/api/bounty/missions/preview` | `previewBountyMission` | Hash-only mission preview | admin | No | No | No | Receipt omits contract bytes and target data |
| POST `/api/bounty/missions/launch` | `launchBountyMission` | Launch an exact preview | admin | No | No | No | Receipt only; launch sends no target effect |
| GET `/api/bounty/missions/{missionId}` | `getBountyMissionStatus` | Mission state/counts | admin | No | No | No | Metadata only |
| GET `.../work` | `listBountyMissionWork` | Paginated work inspection | admin | No | No | No | IDs, state, sequence, hashes |
| GET `.../evidence` | `listBountyMissionEvidence` | Paginated evidence inspection | admin | No | No | No | Payload omitted by default; `raw=true` requires `RORCA_BOUNTY_RAW_CAPABILITY_SHA256` preimage; credential-like fields remain redacted |
| GET `.../findings` | `listBountyMissionFindings` | Paginated finding inspection | admin | No | No | No | Metadata only |
| GET `.../drafts` | `listBountyMissionDrafts` | Paginated local-draft inspection | admin | No | No | No | Bytes/manifests omitted by default; raw mode uses the separate capability |
| GET `.../holds` | `listBountyMissionHolds` | Paginated hold inspection | admin | No | No | No | Control metadata only |
| POST `.../holds` | `createBountyMissionHold` | Advance epoch and hold | admin | No | No | No | Control receipt only |
| POST `.../holds/{holdId}/release` | `releaseBountyMissionHold` | Release reconciled hold | admin | No | No | No | Control receipt only |
| POST `.../pause` | `pauseBountyMission` | Pause/revoke mission authority | admin | No | No | No | Control receipt only |
| POST `.../stop` | `stopBountyMission` | Stop mission work | admin | No | No | No | Control receipt only |
| POST `.../kill` | `killBountyMission` | Emergency process/credential revocation | admin | No | No | No | Control receipt only; credential material is never returned |
| POST `.../drafts/{draftId}/release-review` | `reviewBountyDraftRelease` | Record exact local readiness review | admin | No | No | No | Bundle hash only; always reports `submitted: false` |

## Explicitly absent operations

Target-effect prepare/send/observe IPC is Controller-internal. It has **no REST route, OpenAPI operation, MCP tool, Pi tool, or Hermes operation**. Credential issuance/retrieval is also absent from `/api/bounty`; the existing credential broker accepts material only on its separately authenticated admin boundary and never returns material. There is no report submit, publish, platform, email, or provider transport operation. A release review is a local readiness fact only.

All POST operations require `Idempotency-Key`; exact replay returns the original receipt and changed payload replay fails with `409`. GET operations are naturally idempotent and list operations use bounded cursor/page pagination.

## Presentation clients

The Controller operations above remain uncallable from MCP, Pi, and Hermes. BBM-026 adds a separate read-only projection at `GET /api/contracts/bounty-presentation`, documented in [`bounty-presentation-contract.md`](bounty-presentation-contract.md). It derives schemas, tiers, REST reason codes, and exact receipt semantics from this OpenAPI surface; it does not proxy an operation or grant Controller authority. Hermes may read/preview/present those contracts and relay an exact signed provider-human event through the specifically authorized REST workflow, but never receives DB, queue, adapter, credential, generic URL/browser, broker, callback, local-command, schedule, or submission access.
