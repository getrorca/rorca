/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import swaggerJsdoc from 'swagger-jsdoc';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { missionControlMutationIdempotencyPaths, missionControlReadResponseSchemas, missionControlRequestSchemas,
  missionControlResponseSchemas, missionControlRuntimeHeaderPaths } from '../routes/mission-control';
import { SpecExportKitInputSchema } from './spec-export-kit';

function resolveSwaggerDirname(): string {
  const candidates = [
    path.join(process.cwd(), 'backend/src/lib'),
    path.join(process.cwd(), 'src/lib'),
    path.join(process.cwd(), 'backend/dist/lib'),
    path.join(process.cwd(), 'dist/lib'),
  ];

  return candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, 'swagger.ts')) || fs.existsSync(path.join(candidate, 'swagger.js'))
  )) ?? path.join(process.cwd(), 'backend/src/lib');
}

const swaggerDirname = resolveSwaggerDirname();
// Never load tracked TypeScript and emitted JavaScript siblings together: the
// stale sibling can overwrite current route metadata in swagger-jsdoc's merge.
// Source/tsx runs use TS exclusively; compiled production runs use JS.
const swaggerSourceExtension = fs.existsSync(path.join(swaggerDirname, 'swagger.ts')) ? 'ts' : 'js';
const swaggerApiGlobs = [
  path.join(swaggerDirname, `../routes/*.${swaggerSourceExtension}`),
  path.join(swaggerDirname, `./swagger.${swaggerSourceExtension}`),
];

function loadGovernedSchemas(): Record<string, unknown> {
  const candidates = [
    path.resolve(swaggerDirname, '../../../packages/rorca-public-contract/schemas/governed-execution'),
    path.resolve(process.cwd(), 'packages/rorca-public-contract/schemas/governed-execution'),
  ];
  const directory = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'manifest.json')));
  if (!directory) return {};
  const names: Record<string, unknown> = {};
  for (const file of fs.readdirSync(directory).filter((value) => value.endsWith('.schema.json')).sort()) {
    const contract = file.replace('.schema.json', '');
    const component = `Governed${contract.split('-').map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join('')}`;
    const schema = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as Record<string, unknown>;
    delete schema.$schema;
    names[component] = schema;
  }
  return names;
}
const governedSchemas = loadGovernedSchemas();

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Rorca API',
      version: '2.0.0',
      description:
        'AI spec orchestration and pipeline management for autonomous Claude Code development. ' +
        'Rorca turns plain-English briefs into validated, structured specs via Claude, ' +
        'tracks approval/execution, and provides live pipeline monitoring.',
      contact: { name: 'Rorca', url: 'https://rorca.dev' },
      license: { name: 'Apache-2.0' },
    },
    servers: [{ url: 'http://localhost:3030', description: 'Local dev server' }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Supabase bearer token obtained from the configured Supabase auth flow. ' +
            'Pass as: Authorization: Bearer <token>',
        },
      },
      schemas: {
        ...governedSchemas,
        AuthorityScopeProjectionV1: {
          type: 'object',
          required: ['workspaceId', 'runId', 'storyId', 'environment', 'providerResourceId', 'operation'],
          properties: {
            workspaceId: { type: 'string', minLength: 1, maxLength: 160 },
            runId: { type: 'integer', minimum: 1 },
            storyId: { type: 'string', minLength: 1, maxLength: 512 },
            environment: { type: 'string', minLength: 1, maxLength: 256 },
            providerResourceId: { type: 'string', minLength: 1, maxLength: 1024 },
            operation: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
        AuthorityRequestProjectionV1: {
          unevaluatedProperties: false,
          allOf: [
            { $ref: '#/components/schemas/AuthorityScopeProjectionV1' },
            {
              type: 'object',
              required: ['schemaVersion', 'id', 'intentId', 'requestingPrincipal', 'capabilityId',
                'bindingReference', 'bindingGeneration', 'constraints', 'evidenceDigest', 'requestDigest',
                'status', 'maximumUses', 'expiresAt', 'createdAt', 'updatedAt', 'resolvedAt'],
              properties: {
                schemaVersion: { type: 'string', enum: ['rorca.execution-authority.v1'] },
                id: { type: 'string', format: 'uuid' },
                intentId: { type: 'string', format: 'uuid' },
                requestingPrincipal: { type: 'string', minLength: 1, maxLength: 512 },
                capabilityId: { type: 'string', minLength: 1, maxLength: 256 },
                bindingReference: { type: 'string', minLength: 1, maxLength: 256 },
                bindingGeneration: { type: 'integer', minimum: 1 },
                constraints: { type: 'object', additionalProperties: true },
                evidenceDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                requestDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                status: { type: 'string', enum: ['pending', 'approved', 'denied', 'cancelled', 'expired'] },
                maximumUses: { type: 'integer', minimum: 1, maximum: 1000 },
                expiresAt: { type: 'string', format: 'date-time' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
                resolvedAt: { type: ['string', 'null'], format: 'date-time' },
              },
            },
          ],
        },
        AuthorityDecisionProjectionV1: {
          type: 'object', additionalProperties: false,
          required: ['schemaVersion', 'id', 'workspaceId', 'requestId', 'requestDigest',
            'requestingPrincipal', 'operatorPrincipal', 'decision', 'decisionDigest', 'reasonCode', 'createdAt'],
          properties: {
            schemaVersion: { type: 'string', enum: ['rorca.execution-authority.v1'] },
            id: { type: 'string', format: 'uuid' },
            workspaceId: { type: 'string' },
            requestId: { type: 'string', format: 'uuid' },
            requestDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
            requestingPrincipal: { type: 'string', minLength: 1, maxLength: 512 },
            operatorPrincipal: { type: 'string', minLength: 1, maxLength: 512 },
            decision: { type: 'string', enum: ['approved', 'denied'] },
            decisionDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
            reasonCode: {
              type: 'string',
              enum: ['scope_reviewed', 'change_window_confirmed', 'policy_exception_approved',
                'scope_rejected', 'evidence_insufficient', 'binding_unhealthy', 'request_not_needed'],
            },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        AuthorityGrantProjectionV1: {
          unevaluatedProperties: false,
          allOf: [
            { $ref: '#/components/schemas/AuthorityScopeProjectionV1' },
            {
              type: 'object',
              required: ['schemaVersion', 'id', 'requestId', 'decisionId', 'requestDigest',
                'capabilityId', 'bindingReference', 'bindingGeneration', 'constraints', 'evidenceDigest',
                'maximumUses', 'usesConsumed', 'fencingGeneration', 'status', 'expiresAt', 'createdAt',
                'updatedAt', 'revokedAt'],
              properties: {
                schemaVersion: { type: 'string', enum: ['rorca.execution-authority.v1'] },
                id: { type: 'string', format: 'uuid' },
                requestId: { type: 'string', format: 'uuid' },
                decisionId: { type: 'string', format: 'uuid' },
                requestDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                capabilityId: { type: 'string' },
                bindingReference: { type: 'string' },
                bindingGeneration: { type: 'integer', minimum: 1 },
                constraints: { type: 'object', additionalProperties: true },
                evidenceDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                maximumUses: { type: 'integer', minimum: 1, maximum: 1000 },
                usesConsumed: { type: 'integer', minimum: 0 },
                fencingGeneration: { type: 'integer', minimum: 1 },
                status: { type: 'string', enum: ['active', 'exhausted', 'expired', 'revoked'] },
                expiresAt: { type: 'string', format: 'date-time' },
                createdAt: { type: 'string', format: 'date-time' },
                updatedAt: { type: 'string', format: 'date-time' },
                revokedAt: { type: ['string', 'null'], format: 'date-time' },
              },
            },
          ],
        },
        ExecutionReceiptProjectionV1: {
          unevaluatedProperties: false,
          allOf: [
            { $ref: '#/components/schemas/AuthorityScopeProjectionV1' },
            {
              type: 'object',
              required: ['schemaVersion', 'id', 'attemptId', 'intentId', 'grantId', 'requestDigest',
                'receiptDigest', 'fencingGeneration', 'outcome', 'providerReceiptReference',
                'redactedPayload', 'status', 'retentionClass', 'retainedUntil', 'createdAt', 'settledAt'],
              properties: {
                schemaVersion: { type: 'string', enum: ['rorca.execution-authority.v1'] },
                id: { type: 'string', format: 'uuid' },
                attemptId: { type: 'string', format: 'uuid' },
                intentId: { type: 'string', format: 'uuid' },
                grantId: { type: 'string', format: 'uuid' },
                requestDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                receiptDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                fencingGeneration: { type: 'integer', minimum: 1 },
                outcome: { type: 'string', enum: ['succeeded', 'failed', 'reconciled_succeeded', 'reconciled_failed'] },
                providerReceiptReference: { type: 'string', minLength: 1, maxLength: 1024 },
                redactedPayload: { type: 'object', additionalProperties: true },
                status: { type: 'string', enum: ['settled'] },
                retentionClass: { type: 'string', enum: ['standard', 'extended', 'legal_hold'] },
                retainedUntil: { type: ['string', 'null'], format: 'date-time' },
                createdAt: { type: 'string', format: 'date-time' },
                settledAt: { type: 'string', format: 'date-time' },
              },
            },
          ],
        },
        AuthorityRequestDetailProjectionV1: {
          type: 'object', additionalProperties: false, required: ['request', 'decision', 'grant', 'bindingHealth'],
          properties: {
            request: { $ref: '#/components/schemas/AuthorityRequestProjectionV1' },
            decision: {
              oneOf: [{ $ref: '#/components/schemas/AuthorityDecisionProjectionV1' }, { type: 'null' }],
            },
            grant: {
              oneOf: [{ $ref: '#/components/schemas/AuthorityGrantProjectionV1' }, { type: 'null' }],
            },
            bindingHealth: { type: 'string', enum: ['healthy', 'unhealthy', 'not_assessed'] },
          },
        },
        AuthorityDecisionResultProjectionV1: {
          type: 'object', additionalProperties: false, required: ['decision', 'grant'],
          properties: {
            decision: { $ref: '#/components/schemas/AuthorityDecisionProjectionV1' },
            grant: {
              oneOf: [{ $ref: '#/components/schemas/AuthorityGrantProjectionV1' }, { type: 'null' }],
            },
          },
        },
        AuthorityFailureV1: {
          type: 'object', additionalProperties: false, required: ['error', 'code', 'details'],
          properties: {
            error: { type: 'string' },
            code: {
              type: 'string',
              enum: ['AUTHORITY_REQUEST_DENIED', 'AUTHORITY_REQUEST_CANCELLED', 'AUTHORITY_REQUEST_EXPIRED',
                'AUTHORITY_REQUEST_ALTERED', 'AUTHORITY_REQUEST_REPLAYED', 'AUTHORITY_BINDING_STALE',
                'AUTHORITY_GRANT_EXPIRED', 'AUTHORITY_GRANT_REVOKED', 'AUTHORITY_GRANT_ALTERED',
                'AUTHORITY_GRANT_REPLAYED', 'AUTHORITY_GRANT_OVER_USED'],
            },
            details: {
              type: 'object', additionalProperties: false, required: ['failure'],
              properties: {
                failure: {
                  type: 'object', additionalProperties: false,
                  required: ['schemaVersion', 'code', 'state', 'retryable'],
                  properties: {
                    schemaVersion: { type: 'string', enum: ['rorca.execution-authority-policy.v1'] },
                    code: { type: 'string' },
                    state: { type: 'string' },
                    retryable: { type: 'boolean', enum: [false] },
                    requestId: { type: 'string', format: 'uuid' },
                    grantId: { type: 'string', format: 'uuid' },
                  },
                },
              },
            },
          },
        },
        AuthorityRequestCreateV1: {
          type: 'object', additionalProperties: false, required: ['intentId', 'maximumUses', 'expiresAt'],
          properties: {
            intentId: { type: 'string', format: 'uuid' },
            maximumUses: { type: 'integer', minimum: 1, maximum: 1000 },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        AuthorityDigestMutationV1: {
          type: 'object', additionalProperties: false, required: ['requestDigest'],
          properties: { requestDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } },
        },
        AuthorityApproveMutationV1: {
          type: 'object', additionalProperties: false, required: ['requestDigest', 'reasonCode'],
          properties: {
            requestDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
            reasonCode: {
              type: 'string',
              enum: ['scope_reviewed', 'change_window_confirmed', 'policy_exception_approved'],
            },
          },
        },
        AuthorityDenyMutationV1: {
          type: 'object', additionalProperties: false, required: ['requestDigest', 'reasonCode'],
          properties: {
            requestDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
            reasonCode: {
              type: 'string',
              enum: ['scope_rejected', 'evidence_insufficient', 'binding_unhealthy', 'request_not_needed'],
            },
          },
        },
        PaginatedProjectionV1: {
          type: 'object', additionalProperties: false, required: ['items', 'total', 'hasMore'],
          properties: {
            items: { type: 'array', items: {} },
            total: { type: 'integer', minimum: 0 },
            hasMore: { type: 'boolean' },
            cursor: { type: 'string' },
          },
        },
        Error: {
          type: 'object', required: ['error'], additionalProperties: false,
          properties: {
            error: { type: 'string', description: 'Error message' },
            code: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
          },
        },
        ContextEvent: {
          type:'object',additionalProperties:true,required:['id','workspace_id','source_system','event_type','occurred_at'],
          properties:{id:{type:'integer',minimum:1},workspace_id:{type:'string'},source_system:{type:'string'},event_type:{type:'string'},occurred_at:{type:'string',format:'date-time'},summary:{type:'string',nullable:true},payload:{type:'object',additionalProperties:true}},
        },
        MemoryCandidate: {
          type:'object',additionalProperties:true,required:['id','workspace_id','category','title','rule','status'],
          properties:{id:{type:'integer',minimum:1},workspace_id:{type:'string'},category:{type:'string'},title:{type:'string'},rule:{type:'string'},status:{type:'string'},context:{type:'string',nullable:true}},
        },
        Publication: {
          type:'object',additionalProperties:true,required:['id'],properties:{id:{type:'string'},name:{type:'string'},description:{type:'string',nullable:true}},
        },
        RetrievalTrace: {
          type:'object',additionalProperties:false,required:['schemaVersion','traceId','workspaceId','briefHash','createdAt','candidates'],
          properties:{schemaVersion:{type:'string',enum:['v1']},traceId:{type:'string',minLength:1,maxLength:2000},workspaceId:{type:'string'},briefHash:{type:'string',minLength:1,maxLength:2000},gitSha:{type:'string',pattern:'^[0-9a-f]{7,64}$'},createdAt:{type:'string',format:'date-time'},policy:{type:'string',maxLength:200},graphMode:{type:'string',enum:['full','lite','disabled']},degraded:{type:'boolean'},candidates:{type:'array',items:{$ref:'#/components/schemas/RetrievalCandidate'}},tokenEstimate:{type:'integer',minimum:0}},
        },
        RetrievalCandidate: {
          type: 'object', additionalProperties: false,
          required: ['schemaVersion','id','kind','ref','score','breakdown','trust'],
          properties: {
            schemaVersion: { type: 'string', enum: ['v1'] }, id: { type: 'string', minLength: 1, maxLength: 2000 },
            kind: { type: 'string', enum: ['file','doc','memory','symbol','test'] }, ref: { type: 'string', minLength: 1, maxLength: 2000 },
            title: { type: 'string', maxLength: 500 }, score: { type: 'number', minimum: 0, maximum: 1 },
            breakdown: { type: 'object', additionalProperties: { type: 'number' } }, graphDistance: { type: 'integer', minimum: 0, nullable: true },
            relation: { type: 'string', nullable: true }, role: { type: 'string' }, trust: { type: 'string', enum: ['verified','unverified','disputed'] },
            reason: { type: 'string', maxLength: 2000 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
        ExactPostSaveWorkflowReconciliationRequestV1: {
          type: 'object', additionalProperties: false, required: ['workspaceId','specId','applicationJobId'],
          properties: {
            workspaceId: { type: 'string', minLength: 1, maxLength: 160 },
            specId: { type: 'string', minLength: 1, maxLength: 256 },
            applicationJobId: { type: 'string', format: 'uuid' },
          },
        },
        ExactPostSaveWorkflowReconciliationResultV1: {
          type: 'object', additionalProperties: false,
          required: ['schemaVersion','outcome','reasonCode','workspaceId','specId','workflowRunId','stageKey','applicationJobId','bossJobId','beforeStatus','afterStatus','applicationJobStatus','transport','auditId'],
          properties: {
            schemaVersion: { type: 'string', enum: ['rorca.spec-post-save-reconciliation.v1'] },
            outcome: { type: 'string', enum: ['accepted','rejected','no_op'] }, reasonCode: { type: 'string', minLength: 1, maxLength: 96 },
            workspaceId: { type: 'string', minLength: 1, maxLength: 160 }, specId: { type: 'string', minLength: 1, maxLength: 256 },
            workflowRunId: { type: 'integer', minimum: 1 }, stageKey: { type: 'string', enum: ['enrich','matchSkills','memorySynthesis'] },
            applicationJobId: { type: 'string', format: 'uuid' }, bossJobId: { type: 'string', format: 'uuid', nullable: true },
            beforeStatus: { type: 'string', enum: ['pending','queued','running','completed','failed','skipped'], nullable: true },
            afterStatus: { type: 'string', enum: ['pending','queued','running','completed','failed','skipped'], nullable: true },
            applicationJobStatus: { type: 'string', enum: ['pending','running','completed','failed','cancelled','superseded'], nullable: true },
            transport: { type: 'object', additionalProperties: false, required: ['location','state'], properties: { location: { type: 'string', enum: ['live','archive','missing'] }, state: { type: 'string', maxLength: 32, nullable: true } } },
            auditId: { type: 'integer', minimum: 1, nullable: true },
          },
        },
        ExactPostSaveWorkflowInspectionV1: {
          type: 'object', additionalProperties: false, required: ['schemaVersion','workflow','stages'],
          properties: {
            schemaVersion: { type: 'string', enum: ['rorca.spec-post-save-workflow-inspection.v1'] },
            workflow: { type: 'object', additionalProperties: false, required: ['runId','workspaceId','specId','saveGeneration','generationLogId','effectivePolicyHash','status','source'], properties: {
              runId: { type: 'integer', minimum: 1 }, workspaceId: { type: 'string', minLength: 1, maxLength: 160 }, specId: { type: 'string', minLength: 1, maxLength: 256 },
              saveGeneration: { type: 'integer', minimum: 1, nullable: true }, generationLogId: { type: 'integer', minimum: 1, nullable: true },
              effectivePolicyHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, status: { type: 'string' }, source: { type: 'string' },
            } },
            stages: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['key','requested','status','reason','applicationJobId','bossJobId','transportSchema'], properties: {
              key: { type: 'string', enum: ['context','enrich','matchSkills','memorySynthesis'] }, requested: { type: 'boolean' }, status: { type: 'string' }, reason: { type: 'string' },
              applicationJobId: { type: 'string', format: 'uuid', nullable: true }, bossJobId: { type: 'string', format: 'uuid', nullable: true }, transportSchema: { type: 'string', pattern: '^pgboss(?:_[a-z0-9_]{1,48})?$', nullable: true },
            } } },
          },
        },
        Workspace: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'cashflow-ai' },
            label: { type: 'string', example: 'CashflowAI' },
            path: { type: 'string', example: '/Users/dev/cashflow-ai' },
            domain: { type: 'string', example: 'saas', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        SpecExportKitInput: z.toJSONSchema(SpecExportKitInputSchema, {
          target: 'draft-2020-12',
        }),
        UserStory: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'US-001' },
            title: { type: 'string', example: 'User login' },
            description: { type: 'string' },
            acceptanceCriteria: {
              type: 'array',
              items: { type: 'string' },
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              example: [],
            },
            passes: { type: 'boolean', example: false },
          },
        },
        GenesisProvenance: {
          type: 'object',
          required: [
            'packageId',
            'packageHash',
            'contentHash',
            'canonicalStore',
            'citationSummary',
            'warningCount',
            'skippedEvidenceCount',
            'freshnessTs',
            'bridgeVersion',
          ],
          properties: {
            packageId: { type: 'string' },
            packageHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
            contentHash: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
            canonicalStore: {
              type: 'string',
              enum: [
                'pglite+genesis-vault',
                'pglite+pgvector+genesis-vault',
                'pglite+vault',
                'genesis-pglite-and-local-vault',
              ],
            },
            citationSummary: { type: 'string', maxLength: 512 },
            warningCount: { type: 'integer', minimum: 0 },
            skippedEvidenceCount: { type: 'integer', minimum: 0 },
            freshnessTs: { type: 'string', format: 'date-time' },
            bridgeVersion: { type: 'string', maxLength: 64 },
          },
          additionalProperties: true,
        },
        Spec: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'my-spec-slug' },
            slug: { type: 'string', example: 'my-spec-slug' },
            title: { type: 'string', example: 'My Spec' },
            userStories: {
              type: 'array',
              items: { $ref: '#/components/schemas/UserStory' },
            },
            model: {
              type: 'string',
              example: 'claude-sonnet-4-6',
            },
            contextUsed: {
              type: 'object',
              properties: {
                genesis: { $ref: '#/components/schemas/GenesisProvenance' },
              },
              additionalProperties: true,
            },
            contextSummary: {
              type: 'object',
              properties: {
                genesis: { $ref: '#/components/schemas/GenesisProvenance' },
              },
              additionalProperties: true,
            },
            generatedAt: { type: 'string', format: 'date-time' },
          },
        },
        PipelineRun: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            workspace_id: { type: 'string' },
            spec_path: { type: 'string' },
            status: {
              type: 'string',
              enum: ['queued', 'running', 'release_pending', 'done', 'failed', 'partial_failure', 'paused', 'cancelled', 'pi_native'],
            },
            pid: { type: 'integer', nullable: true },
            started_at: { type: 'string', format: 'date-time' },
            finished_at: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
            branch_name: { type: 'string', nullable: true },
            worktree_path: { type: 'string', nullable: true, description: 'Immutable execution checkout identity; cleanup is reported separately.' },
            execution_workspace_path: { type: 'string', nullable: true, description: 'Host-frozen canonical workspace realpath.' },
            execution_worktree_path: { type: 'string', nullable: true, description: 'Host-frozen execution checkout realpath.' },
            terminal_checkout_sha: { type: 'string', pattern: '^[0-9a-f]{40}$', nullable: true },
            worktree_cleanup_status: { type: 'string', enum: ['not_started', 'pending', 'completed', 'failed'] },
            // Canonical normalized metadata. Snake_case database fields remain
            // available during the API compatibility window.
            agentType: { type: 'string', enum: ['claude', 'opencode', 'codex', 'pi', 'unknown'] },
            agentModel: { type: 'string', nullable: true },
            terminalMode: { type: 'string', enum: ['ansi-html', 'pty', 'native-pty'] },
            lifecycleStatus: {
              type: 'string',
              enum: ['queued', 'starting', 'pty_attached', 'running', 'validating', 'finished', 'failed', 'cancelled'],
            },
            // Compatibility alias for clients that adopted metadata v1 first.
            lifecyclePhase: {
              type: 'string',
              nullable: true,
              enum: ['queued', 'starting', 'pty_attached', 'running', 'validating', 'finished', 'failed', 'cancelled'],
            },
          },
        },
        StoryResult: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            run_id: { type: 'integer' },
            story_id: { type: 'string', example: 'US-001' },
            status: {
              type: 'string',
              enum: ['passed', 'failed', 'skipped'],
            },
            started_at: { type: 'string', format: 'date-time' },
            finished_at: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
          },
        },
        WalEvent: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            event_type: {
              type: 'string',
              enum: [
                'generate',
                'spec_approved',
                'spec_rejected',
                'run_started',
                'story_started',
                'story_passed',
                'story_failed',
                'story_skipped',
                'run_finished',
                'worktree_created',
                'worktree_merged',
              ],
            },
            spec_id: { type: 'string', nullable: true },
            workspace_id: { type: 'string', nullable: true },
            payload: { type: 'object' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        LocalReviewBundleReadModel: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaVersion', 'bundleId', 'adapter', 'identity', 'specification', 'repository', 'changedFileCount', 'changedContentBytes', 'artifacts', 'validation', 'createdAt', 'projectionKey', 'projectionIntegrity', 'delivery'],
          properties: {
            schemaVersion: { type: 'string', enum: ['rorca.local-review-bundle-read.v1'] },
            bundleId: { type: 'string', pattern: '^lrb-[0-9a-f]{64}$' },
            adapter: {
              type: 'object', additionalProperties: false,
              required: ['contractVersion', 'adapterId', 'adapterVersion', 'default', 'requiresNetwork', 'requiresCredentials'],
              properties: {
                contractVersion: { type: 'string', enum: ['rorca.delivery-adapter.v1'] },
                adapterId: { type: 'string', enum: ['local-review-bundle'] },
                adapterVersion: { type: 'string' },
                default: { type: 'boolean', enum: [true] },
                requiresNetwork: { type: 'boolean', enum: [false] },
                requiresCredentials: { type: 'boolean', enum: [false] },
              },
            },
            identity: {
              type: 'object', additionalProperties: false,
              required: ['workspaceId', 'specId', 'storyId', 'runId', 'attempt', 'generation', 'hostAttemptEnvelopeId'],
              properties: {
                workspaceId: { type: 'string' }, specId: { type: 'string' }, storyId: { type: 'string' },
                runId: { type: 'integer' }, attempt: { type: 'integer' },
                generation: { type: 'string', format: 'uuid' }, hostAttemptEnvelopeId: { type: 'string', format: 'uuid' },
              },
            },
            specification: {
              type: 'object', additionalProperties: false,
              required: ['canonicalPath', 'revision', 'bytesHash', 'storyRevision', 'executionManifestHash'],
              properties: {
                canonicalPath: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^(?!/)(?!.*\\\\)(?!.*(?:^|/)(?:\\.|\\.\\.)(?:/|$))(?!.*//)(?!.*[\\u0000-\\u001f\\u007f]).+$' }, revision: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                bytesHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                storyRevision: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                executionManifestHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
              },
            },
            repository: {
              type: 'object', additionalProperties: false,
              required: ['repositoryIdentity', 'repositoryPathDigest', 'worktreeIdentity', 'worktreePathDigest', 'runBaseSha', 'baseSha', 'headSha', 'branch'],
              properties: {
                repositoryIdentity: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                repositoryPathDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                worktreeIdentity: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                worktreePathDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                runBaseSha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
                baseSha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
                headSha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
                branch: { type: 'string' },
              },
            },
            changedFileCount: { type: 'integer', minimum: 0, maximum: 500 },
            changedContentBytes: { type: 'integer', minimum: 0, maximum: 8388608 },
            artifacts: {
              type: 'array', minItems: 1, maxItems: 1,
              items: {
                type: 'object', additionalProperties: false,
                required: ['name', 'mediaType', 'bytes', 'sha256'],
                properties: {
                  name: { type: 'string', enum: ['changes.patch'] }, mediaType: { type: 'string', enum: ['text/x-diff'] },
                  bytes: { type: 'integer', minimum: 0, maximum: 8388608 }, sha256: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                },
              },
            },
            validation: {
              type: 'object', additionalProperties: false,
              required: ['status', 'authoredBy', 'receiptCount', 'evidenceReferenceCount', 'rejectsAgentAuthoredPass'],
              properties: {
                status: { type: 'string', enum: ['passed', 'blocked'] },
                authoredBy: { type: 'string', enum: ['host_closeout', 'none'] },
                receiptCount: { type: 'integer', minimum: 0, maximum: 32 },
                evidenceReferenceCount: { type: 'integer', minimum: 0, maximum: 64 },
                rejectsAgentAuthoredPass: { type: 'boolean', enum: [true] },
              },
            },
            createdAt: { type: 'string', format: 'date-time' },
            projectionKey: { type: 'string', pattern: '^sha256/[0-9a-f]{2}/[0-9a-f]{64}$' },
            projectionIntegrity: { type: 'string', enum: ['verified', 'missing', 'corrupt'] },
            delivery: {
              type: 'object', additionalProperties: false,
              required: ['reviewStatus', 'mergeStatus', 'deploymentStatus', 'mergeAuthority', 'deploymentAuthority'],
              properties: {
                reviewStatus: { type: 'string', enum: ['awaiting_local_review'] },
                mergeStatus: { type: 'string', enum: ['not_authorized'] },
                deploymentStatus: { type: 'string', enum: ['not_authorized'] },
                mergeAuthority: { type: 'string', enum: ['none'] },
                deploymentAuthority: { type: 'string', enum: ['none'] },
              },
            },
          },
        },
        DirectionLayer: {
          type: 'object',
          properties: {
            layer: { type: 'integer', enum: [1, 2, 3] },
            workspace_id: { type: 'string', nullable: true },
            domain: { type: 'string', nullable: true },
            content_yaml: { type: 'string' },
            preferred_model: { type: 'string', nullable: true },
          },
        },
        Template: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            brief: { type: 'string' },
            story_structure: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            avg_rating: { type: 'number', nullable: true },
            rating_count: { type: 'integer' },
          },
        },
        GitWorktree: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            branch: { type: 'string' },
            head: { type: 'string' },
            isBare: { type: 'boolean' },
            isMain: { type: 'boolean' },
          },
        },
        Team: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            slug: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    security: [{ BearerAuth: [] }],
    tags: [
      { name: 'Auth', description: 'Authentication and user management' },
      { name: 'Workspaces', description: 'Git repository workspace management' },
      { name: 'Direction Stack', description: 'L1-L5 direction layer configuration' },
      { name: 'Specs', description: 'Spec generation, review, and approval' },
      { name: 'Pipeline', description: 'Pipeline execution, monitoring, and SSE streams' },
      { name: 'Worktrees', description: 'Git worktree management' },
      { name: 'Templates', description: 'Reusable spec templates' },
      { name: 'Stories', description: 'Cross-spec story search' },
      { name: 'WAL', description: 'Write-ahead log event stream' },
      { name: 'Context', description: 'Context extraction for direction layers' },
      { name: 'Analytics', description: 'Usage analytics, costs, velocity, and export' },
      { name: 'Health', description: 'Health check' },
      { name: 'Delivery', description: 'Provider-neutral local review delivery and optional provider adapters' },
      { name: 'GitHub', description: 'Optional GitHub repository integration and webhooks' },
      { name: 'Vault', description: 'Encrypted API key vault management' },
      { name: 'Agent Profiles', description: 'Named agent configurations (model, temperature, etc.)' },
      { name: 'Agent Hooks', description: 'Pre/post story lifecycle hook management' },
      { name: 'Notifications', description: 'In-app notification preferences and history' },
      { name: 'Settings', description: 'User settings and preferences' },
      { name: 'Webhooks', description: 'Incoming webhook receivers (GitHub, etc.)' },
      { name: 'Environment Variables', description: 'Per-workspace environment variable injection' },
      { name: 'Users', description: 'Local user profile and account operations' },
      { name: 'Budget', description: 'Workspace spending limits and budget configuration' },
      { name: 'Activity', description: 'Activity feed and audit trail' },
      { name: 'Onboarding', description: 'Onboarding wizard state management' },
      { name: 'Admin', description: 'Administrative operations (backups, maintenance)' },
      { name: 'Config', description: 'Orchestration configuration (.rorca/config.json)' },
      { name: 'Context Routing', description: 'Virtual context routing rules' },
      { name: 'Context Files', description: 'Context file management (CLAUDE.md, MEMORY.md, AGENTS.md)' },
      { name: 'Skills', description: 'Skill library management (.rorca/skills/)' },
      { name: 'Personas', description: 'Agent persona definitions and management' },
      { name: 'Conventions', description: 'Convention discovery, checking, and drift detection' },
      { name: 'Packs', description: 'Convention pack installation and management' },
    ],
  },
  apis: swaggerApiGlobs,
};

/**
 * @swagger
 * /api/health:
 *   get:
 *     tags: [Health]
 *     summary: Health check
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Unauthenticated read-only process health is required for local CLI, sidecar queue flushing, and CI readiness checks."
 *     x-rorca-public-api: true
 *     security: []
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 ts: { type: string, format: date-time }
 */

let swaggerSpec: ReturnType<typeof swaggerJsdoc>;
try {
  swaggerSpec = swaggerJsdoc(options);
} catch (e) {
  // Swagger YAML parse errors are non-fatal — log and continue with empty spec
  console.warn('[swagger] Failed to parse swagger annotations:', (e as Error).message?.slice(0, 200));
  swaggerSpec = { openapi: '3.1.0', info: { title: 'Rorca API', version: '1.0.0' }, paths: {} };
}
function connectMissionControlWireContracts(specification: ReturnType<typeof swaggerJsdoc>): void {
  const spec = specification as unknown as { paths?: Record<string, Record<string, Record<string, unknown>>>;
    components?: { schemas?: Record<string, unknown> } };
  const schemas = spec.components?.schemas ?? {};
  if (spec.components) spec.components.schemas = schemas;
  const toOpenApiSchema = (schema: z.ZodType): Record<string, unknown> => {
    const converted = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
    delete converted.$schema;
    return converted;
  };
  const componentName = (apiPath: string, suffix: string) => `MissionControl${apiPath.replace('/api/mission-control/v1/', '').split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join('')}${suffix}`;
  const errorResponse = { description: 'Standard AppError envelope', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  for (const [apiPath, methods] of Object.entries(spec.paths ?? {})) {
    if (!apiPath.startsWith('/api/mission-control/v1/')) continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const parameters=(operation.parameters??[]) as Array<Record<string,unknown>>;
      if(method==='post'&&missionControlMutationIdempotencyPaths.has(apiPath))parameters.push({in:'header',name:'Idempotency-Key',required:true,
        description:'Exact governed mutation replay key',schema:{type:'string',minLength:8,maxLength:200}});
      if(method==='post'&&missionControlRuntimeHeaderPaths.has(apiPath))parameters.push({in:'header',name:'X-Rorca-Runtime-Id',required:true,
        description:'Exact leased runtime principal relayed by the bounded internal service',schema:{type:'string',minLength:2,maxLength:128}});
      if(parameters.length>0)operation.parameters=parameters;
      if (method === 'post') {
        const requestName = componentName(apiPath, 'Request');
        const requestSchema = missionControlRequestSchemas[apiPath];
        if (!requestSchema) throw new Error(`Mission-control request schema is missing for ${apiPath}`);
        schemas[requestName] = toOpenApiSchema(requestSchema);
        operation.requestBody = { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${requestName}` } } } };
      }
      const responses = (operation.responses ?? {}) as Record<string, unknown>;
      if (method === 'post') {
        const responseName = componentName(apiPath, 'Response');
        const responseSchema = missionControlResponseSchemas[apiPath];
        if (!responseSchema) throw new Error(`Mission-control response schema is missing for ${apiPath}`);
        schemas[responseName] = toOpenApiSchema(responseSchema);
        responses['200'] = { description: 'Governed operation result', content: { 'application/json': {
          schema: { $ref: `#/components/schemas/${responseName}` } } } };
      } else {
        const responseName=componentName(apiPath,'ReadResponse');
        const responseSchema=missionControlReadResponseSchemas[apiPath];
        if(!responseSchema)throw new Error(`Mission-control read response schema is missing for ${apiPath}`);
        schemas[responseName]=toOpenApiSchema(responseSchema);
        responses['200']={description:'Sanitized governed read projection',content:{'application/json':{
          schema:{$ref:`#/components/schemas/${responseName}`}}}};
      }
      for (const code of ['400', '401', '403', '404', '409', '410', '413', '422', '500']) responses[code] ??= errorResponse;
      operation.responses = responses;
    }
  }
}
connectMissionControlWireContracts(swaggerSpec);

/**
 * swagger-jsdoc accepts shorthand fragments that are not Response Objects.
 * Publish only standards-valid OAS 3.1 wire shapes: preserve valid content,
 * and isolate malformed legacy shorthand behind a truthful generic response
 * rather than claiming that raw JSON-Schema-ish keys are OpenAPI responses.
 */
function normalizePublishedOpenApi31(specification:ReturnType<typeof swaggerJsdoc>):void{
  const spec=specification as unknown as {info?:{license?:Record<string,unknown>};paths?:Record<string,Record<string,Record<string,unknown>>>};
  if(spec.info?.license&&!spec.info.license.identifier&&!spec.info.license.url)spec.info.license.identifier='Apache-2.0';
  const responseKeys=new Set(['$ref','summary','description','headers','content','links']);
  for(const methods of Object.values(spec.paths??{}))for(const [method,operation] of Object.entries(methods)){
    if(!['get','post','put','patch','delete','options','head','trace'].includes(method))continue;
    const parameters=(operation.parameters??[]) as Array<Record<string,unknown>>;
    for(const parameter of parameters){
      if(!parameter.schema&&!parameter.content&&!parameter.$ref)parameter.schema={type:'string'};
    }
    const responses=(operation.responses??{}) as Record<string,Record<string,unknown>>;
    for(const [code,response] of Object.entries(responses)){
      if(!response||typeof response!=='object'){responses[code]={description:'Response'};continue;}
      const invalid=Object.keys(response).some(key=>!responseKeys.has(key));
      const content=response.content&&typeof response.content==='object'&&!Array.isArray(response.content)?response.content:undefined;
      if(invalid||(!response.description&&!response.$ref))responses[code]={description:typeof response.description==='string'?response.description:'Response',...(content?{content}:{})};
    }
    operation.responses=responses;
  }
}
normalizePublishedOpenApi31(swaggerSpec);
export { swaggerSpec };
