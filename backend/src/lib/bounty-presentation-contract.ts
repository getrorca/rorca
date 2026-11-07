/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenAPI-derived, presentation-only bounty client contract.
 */

export const BOUNTY_PRESENTATION_CONTRACT_VERSION = 'bounty.presentation.v1' as const;
export const BOUNTY_CONTROLLER_RECEIPT_MODE = 'exact-rest-json-no-rewrite' as const;
export const BOUNTY_PRESENTATION_OPERATION_IDS = [
  'previewBountyMission',
  'getBountyMissionStatus',
  'listBountyMissionWork',
  'listBountyMissionEvidence',
  'listBountyMissionFindings',
  'listBountyMissionDrafts',
  'listBountyMissionHolds',
  'reviewBountyDraftRelease',
] as const;

export const BOUNTY_PRESENTATION_REASON_CODES = Object.freeze({
  '400': 'VALIDATION_ERROR',
  '401': 'AUTH_ERROR',
  '403': 'FORBIDDEN',
  '404': 'NOT_FOUND',
  '409': 'CONFLICT',
  '422': 'UNPROCESSABLE',
  featureDisabled: 'BOUNTY_FEATURE_DISABLED',
});

export const BOUNTY_PRESENTATION_FORBIDDEN_CAPABILITIES = [
  'database',
  'queue',
  'target-adapter',
  'credential',
  'generic-url',
  'browser-command',
  'broker-request',
  'raw-credential',
  'callback',
  'local-command',
  'schedule',
  'submission',
] as const;

type OpenApiOperation = Record<string, unknown> & {
  operationId?: string;
  parameters?: unknown;
  requestBody?: unknown;
  responses?: Record<string, unknown>;
};

export interface BountyPresentationOpenApi {
  paths?: Record<string, Record<string, OpenApiOperation | undefined> | undefined>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Build only metadata/projections from the canonical REST document. This does
 * not make Controller operations callable: the sole MCP/Pi tool is the bounded
 * read-only contract endpoint, while human actions continue through exact REST
 * endpoints and their signed provider-human event fields.
 */
export function buildBountyPresentationContract(spec: BountyPresentationOpenApi) {
  const selected = new Map<string, { method: string; path: string; operation: OpenApiOperation }>();
  for (const [pathname, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods ?? {})) {
      if (!operation?.operationId || !BOUNTY_PRESENTATION_OPERATION_IDS.includes(operation.operationId as never)) continue;
      selected.set(operation.operationId, { method: method.toUpperCase(), path: pathname, operation });
    }
  }

  const operations = BOUNTY_PRESENTATION_OPERATION_IDS.map((operationId) => {
    const found = selected.get(operationId);
    if (!found) throw new TypeError(`OpenAPI operation ${operationId} is required by ${BOUNTY_PRESENTATION_CONTRACT_VERSION}`);
    const operation = found.operation;
    return {
      operationId,
      method: found.method,
      path: found.path,
      tier: operation['x-rorca-tier'],
      rationale: operation['x-rorca-rationale'],
      mcpCallable: operation['x-rorca-mcp'] !== false,
      input: clone({ parameters: operation.parameters ?? [], requestBody: operation.requestBody ?? null }),
      responses: clone(operation.responses ?? {}),
      reasonCodes: clone(BOUNTY_PRESENTATION_REASON_CODES),
      receiptMode: BOUNTY_CONTROLLER_RECEIPT_MODE,
    };
  });

  return Object.freeze({
    schemaVersion: BOUNTY_PRESENTATION_CONTRACT_VERSION,
    source: 'rest-openapi',
    controllerReceiptMode: BOUNTY_CONTROLLER_RECEIPT_MODE,
    reasonCodes: BOUNTY_PRESENTATION_REASON_CODES,
    operations,
    clients: Object.freeze({
      mcp: Object.freeze({ derivation: 'openapi', transport: 'bounded-read-only-contract-tool' }),
      pi: Object.freeze({ derivation: 'mcp-exact-schema-clone', transport: 'bounded-read-only-contract-tool' }),
      hermes: Object.freeze({
        roles: Object.freeze(['read', 'preview', 'present', 'exact-human-relay']),
        authority: 'signed-provider-human-event-only',
        controllerReceipts: BOUNTY_CONTROLLER_RECEIPT_MODE,
        directAccess: Object.freeze([]),
      }),
    }),
    forbiddenCapabilities: BOUNTY_PRESENTATION_FORBIDDEN_CAPABILITIES,
  });
}
