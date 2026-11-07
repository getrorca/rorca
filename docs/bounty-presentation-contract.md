# Bounty presentation contracts for MCP, Pi, and Hermes

`bounty.presentation.v1` is a read-only client contract derived at runtime from Rorca's canonical REST/OpenAPI document. Its endpoint is `GET /api/contracts/bounty-presentation`; OpenAPI generates the MCP tool `rorca_contracts_bounty_presentation`, and the Pi extension registers that same MCP tool with an exact clone of its input schema.

## One source of contract truth

The presentation response selects bounded Controller operations by stable REST `operationId` and copies, without reinterpretation:

- request parameters and request-body schemas;
- `x-rorca-tier` and rationale;
- documented responses and Controller receipt representations;
- REST/AppError reason codes; and
- `exact-rest-json-no-rewrite` receipt semantics.

The selected Controller operations remain `admin` tier with `x-rorca-mcp: false`. The only bounty MCP/Pi operation is the authenticated, read-only contract projection. MCP and Pi do not become alternate Controller transports and cannot weaken an admin tier, rename a reason code, or rewrite a receipt.

## Hermes role

Hermes is a presentation client, not a bounty execution plane. It may:

1. **read** mission state and bounded metadata returned by Rorca;
2. **preview** an exact Controller action or approval target;
3. **present** state, blockers, reason codes, expiry, and the exact approval target to a human; and
4. **relay** the exact signed `provider-human-event.v1` received from the configured provider.

Hermes must not normalize, reconstruct, approve, or sign the human event. Rorca verifies issuer/key, provider tenant/workspace binding, target hash, freshness, idempotency, actor separation, and signature, then returns the canonical Controller receipt. Hermes presents that receipt unchanged.

The compatibility fixture is `backend/src/lib/__tests__/fixtures/hermes-bounty-presentation-client.json`.

## Explicitly unavailable

No bounty MCP, Pi, or Hermes tool grants direct access to:

- the database or pg-boss queue;
- target adapters or brokers;
- credentials or raw credential material;
- generic URLs or browser commands;
- callbacks;
- local commands;
- schedules; or
- report submission/publishing.

Those names are forbidden presentation capabilities, not hidden optional parameters. Target effects remain behind the Controller boundary described in [`bounty-rest-operation-matrix.md`](bounty-rest-operation-matrix.md).

## TaskManifest boundary

`TaskManifest v1` remains the ordinary software-repair lane. Parsing defaults `workType` to `software-repair` and rejects bounty authority fields, bounty/target dispatch routes, and target/network-tool commands. Hermes cannot turn TaskManifest into bounty work by adding `missionId`, `programId`, `workPackageId`, a target broker, credential reference, or bounty work type.

## Version handshake

`GET /api/version` advertises:

- `contractVersion: bounty.presentation.v1`;
- `source: rest-openapi`;
- `controllerReceiptMode: exact-rest-json-no-rewrite`;
- `humanAuthorityVersion: provider-human-event.v1`; and
- Hermes roles `read`, `preview`, `present`, `exact-human-relay`.

Clients must fail closed on an unsupported contract or human-authority version.
