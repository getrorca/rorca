/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CA-021: MCP Streamable HTTP Transport — auto-generated from OpenAPI spec.
 *
 * Generates MCP tools from the OpenAPI spec at /api/docs/openapi.json and serves
 * them via Streamable HTTP transport at /mcp. Every Express route with @swagger
 * annotations becomes an MCP tool automatically with zero hand-written MCP code.
 *
 * Tool naming: {method}_{path_segments} → e.g. POST /api/packs/install → rorca_post_packs_install
 * Then normalized to rorca_ prefix: rorca_packs_install
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Request, Response } from 'express';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SpecJobState } from '../db/spec-jobs';
import { pollSpecJob } from '../mcp/spec-job-poller';
import type { McpTier } from './mcp-auth';
import { consumeMcpRateLimit, extractErrorCode, paramsHash, recordMcpCall } from './mcp-audit';
import { logger } from './logger';
import {
  replayRunEvents,
  RunEventSubscription,
  RUN_EVENT_SUBSCRIPTION_TOOL_NAMES,
} from './run-event-subscription';
import { getRorcaTier, tierAllowedFromMcp } from './tier-auth';

// Claude Code truncates tool results over ~25k tokens (~100k chars).
// When a response is too large, we spill it to disk and return a summary
// so the agent can choose to Grep/Read targeted slices instead of loading the whole thing.
const MAX_INLINE_CHARS = 80_000;
const SPILL_DIR = path.join(os.tmpdir(), 'rorca-mcp-results');

function spillLargeResult(toolName: string, body: unknown, fullText: string): string {
  try {
    fs.mkdirSync(SPILL_DIR, { recursive: true });
  } catch { /* best effort */ }
  const fname = `${toolName}-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const filePath = path.join(SPILL_DIR, fname);
  try {
    fs.writeFileSync(filePath, fullText, 'utf8');
  } catch (err) {
    logger.warn(`[MCP-HTTP] Failed to spill large result: ${err instanceof Error ? err.message : err}`);
  }

  // Build a compact summary the agent can reason about without reading the file.
  const summary: Record<string, unknown> = {
    _truncated: true,
    _reason: `Response is ${fullText.length.toLocaleString()} chars — exceeds ${MAX_INLINE_CHARS.toLocaleString()} char inline limit.`,
    _fullResultAt: filePath,
    _hint: 'Use Read or Grep on _fullResultAt to retrieve specific fields. Do NOT read the whole file.',
  };

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    // Surface commonly-useful lightweight fields so the caller rarely needs to read the file
    const lightKeys = ['ok', 'id', 'slug', 'title', 'status', 'specId', 'runId', 'model', 'usage', 'message', 'note', 'error', 'code', 'count', 'total'];
    for (const k of lightKeys) {
      if (k in obj) summary[k] = obj[k];
    }
    // If there's an items/stories/results array, report length + first-item keys (not content)
    for (const arrKey of ['items', 'results', 'userStories', 'stories', 'data']) {
      const v = obj[arrKey];
      if (Array.isArray(v)) {
        const first = v[0];
        summary[`${arrKey}_length`] = v.length;
        if (first && typeof first === 'object') {
          summary[`${arrKey}_shape`] = Object.keys(first as Record<string, unknown>).slice(0, 20);
        }
      }
    }
  }

  return JSON.stringify(summary, null, 2);
}

const RORCA_API = process.env.RORCA_API_URL || 'http://localhost:3030';

// ─── OpenAPI spec types (subset we need) ────────────────────────────────────

interface OpenAPIPropertySchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  nullable?: boolean;
  $ref?: string;
  items?: OpenAPIPropertySchema;
  properties?: Record<string, OpenAPIPropertySchema>;
  additionalProperties?: boolean | OpenAPIPropertySchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
}

interface OpenAPIParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  schema?: OpenAPIPropertySchema;
  description?: string;
}

interface OpenAPIOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  'x-rorca-tier'?: string;
  'x-rorca-rationale'?: string;
  'x-rorca-public-api'?: boolean;
  'x-mcp-tier'?: string;
  /** Explicit opt-out for privileged REST-only operations. */
  'x-rorca-mcp'?: boolean;
  parameters?: OpenAPIParameter[];
  requestBody?: {
    required?: boolean;
    content?: {
      [mediaType: string]: {
        schema?: {
          type?: string;
          required?: string[];
          properties?: Record<string, OpenAPIPropertySchema>;
        };
      };
    };
  };
  security?: Array<Record<string, string[]>>;
}

interface OpenAPISpec {
  paths: Record<string, Record<string, OpenAPIOperation>>;
}

interface McpToolDefinition {
  toolName: string;
  description: string;
  zodShape: Record<string, z.ZodType>;
  capturedMethod: string;
  capturedPath: string;
  capturedOperation: OpenAPIOperation;
}

export interface PublishedMcpTool {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  requiredParams: string[];
}

interface McpFriendlyAlias {
  toolName: string;
  description: string;
  method: string;
  path: string;
}

interface McpHttpServerOptions {
  resolveSessionTier?: (sessionId: string | undefined) => McpTier | undefined;
  getSessionRemoteAddr?: (sessionId: string | undefined) => string | undefined;
  defaultSessionId?: string;
  /** Authorized principal bound to an MCP session (upstream auth). */
  resolveSessionPrincipal?: (sessionId: string | undefined) => string | undefined;
  /** Workspace allowlist bound to an MCP session; only allowlisted workspaces may be selected or written. */
  resolveSessionWorkspaceAllowlist?: (sessionId: string | undefined) => readonly string[] | undefined;
}

/**
 * W5-009 omp session tools. rorca_select_workspace enumerates workspaces and
 * rorca_record_subagent_run writes another tenant's memory, so both are
 * ADMIN-only — a public MCP bearer must never select or mutate a workspace.
 * rorca_current_workspace only reflects session state the caller already set.
 */
const CUSTOM_SESSION_TOOL_TIERS: Record<string, McpTier> = {
  rorca_select_workspace: 'admin',
  rorca_current_workspace: 'public',
  rorca_record_subagent_run: 'admin',
  rorca_subscribe_run_events: 'admin',
  rorca_unsubscribe_run_events: 'admin',
};


function getMcpExposureOverride(operation: OpenAPIOperation): McpTier | null {
  const raw = operation['x-mcp-tier'];
  if (raw === 'public' || raw === 'admin') {
    return raw;
  }
  return null;
}

const PUBLIC_TOOL_RULES: Array<{ method: string; pattern: RegExp }> = [
  // Specs — read
  { method: 'GET', pattern: /^\/api\/specs(?:\/[^/]+(?:\/versions(?:\/[^/]+\/diff)?)?)?$/ },
  { method: 'GET', pattern: /^\/api\/specs\/archive$/ },
  { method: 'GET', pattern: /^\/api\/specs\/kanban$/ },
  { method: 'GET', pattern: /^\/api\/specs\/[^/]+\/graph$/ },
  { method: 'GET', pattern: /^\/api\/specs\/[^/]+\/knowledge-graph$/ },
  { method: 'GET', pattern: /^\/api\/specs\/search-stories$/ },
  { method: 'GET', pattern: /^\/api\/specs\/[^/]+\/generation-log$/ },
  // Specs — mutations (core open-source workflow)
  { method: 'POST', pattern: /^\/api\/specs\/generate$/ },
  { method: 'POST', pattern: /^\/api\/specs\/persist$/ },
  { method: 'POST', pattern: /^\/api\/specs\/generate\/batch$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/approve$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/reject$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/add-stories$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/fork$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/fix$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/check$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/score$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/validate$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/enrich$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/match-skills$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/suggest-skills$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/suggest-models$/ },
  { method: 'POST', pattern: /^\/api\/specs\/[^/]+\/stories\/bulk$/ },
  { method: 'PUT', pattern: /^\/api\/specs\/[^/]+$/ },
  { method: 'PATCH', pattern: /^\/api\/specs\/[^/]+\/stories\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/api\/specs\/[^/]+\/stories\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/api\/specs\/[^/]+$/ },
  // Pipeline
  { method: 'GET', pattern: /^\/api\/pipeline\/runs(?:\/[^/]+)?$/ },
  { method: 'GET', pattern: /^\/api\/pipeline\/worker\/health$/ },
  { method: 'GET', pattern: /^\/api\/pipeline\/runs\/[^/]+\/log$/ },
  { method: 'POST', pattern: /^\/api\/pipeline\/trigger$/ },
  { method: 'POST', pattern: /^\/api\/pipeline\/task-manifests\/trigger$/ },
  { method: 'POST', pattern: /^\/api\/pipeline\/runs\/[^/]+\/cancel$/ },
  { method: 'POST', pattern: /^\/api\/pipeline\/runs\/[^/]+\/retry$/ },
  { method: 'POST', pattern: /^\/api\/pipeline\/runs\/[^/]+\/pause$/ },
  { method: 'POST', pattern: /^\/api\/pipeline\/runs\/[^/]+\/resume$/ },
  // Analytics & observability
  { method: 'GET', pattern: /^\/api\/analytics$/ },
  { method: 'GET', pattern: /^\/api\/activity$/ },
  { method: 'GET', pattern: /^\/api\/wal$/ },
  { method: 'POST', pattern: /^\/api\/wal$/ },
  // Direction
  { method: 'GET', pattern: /^\/api\/direction$/ },
  { method: 'PUT', pattern: /^\/api\/direction$/ },
  { method: 'POST', pattern: /^\/api\/direction\/synthesize$/ },
  { method: 'POST', pattern: /^\/api\/direction\/preview$/ },
  { method: 'GET', pattern: /^\/api\/direction\/models$/ },
  { method: 'POST', pattern: /^\/api\/direction\/wizard$/ },
  // Workspaces
  { method: 'GET', pattern: /^\/api\/workspaces(?:\/[^/]+)?$/ },
  { method: 'POST', pattern: /^\/api\/workspaces$/ },
  { method: 'PATCH', pattern: /^\/api\/workspaces\/[^/]+$/ },
  { method: 'GET', pattern: /^\/api\/workspaces\/[^/]+\/health$/ },
  { method: 'GET', pattern: /^\/api\/workspaces\/[^/]+\/stats$/ },
  { method: 'GET', pattern: /^\/api\/workspaces\/[^/]+\/context$/ },
  { method: 'POST', pattern: /^\/api\/workspaces\/[^/]+\/hydrate$/ },
  { method: 'POST', pattern: /^\/api\/workspaces\/[^/]+\/scan-direction$/ },
  { method: 'GET', pattern: /^\/api\/workspaces\/[^/]+\/rorca-config$/ },
  { method: 'PUT', pattern: /^\/api\/workspaces\/[^/]+\/rorca-config$/ },
  { method: 'GET', pattern: /^\/api\/workspaces\/[^/]+\/skills$/ },
  { method: 'GET', pattern: /^\/api\/workspaces\/[^/]+\/drift$/ },
  { method: 'POST', pattern: /^\/api\/workspaces\/[^/]+\/echolocate$/ },
  // Memory
  { method: 'GET', pattern: /^\/api\/memory$/ },
  { method: 'POST', pattern: /^\/api\/memory$/ },
  { method: 'PUT', pattern: /^\/api\/memory\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/api\/memory\/[^/]+$/ },
  { method: 'GET', pattern: /^\/api\/memory\/items$/ },
  { method: 'GET', pattern: /^\/api\/memory\/categories$/ },
  { method: 'GET', pattern: /^\/api\/memory\/context$/ },
  { method: 'POST', pattern: /^\/api\/memory\/synthesize-from-run\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/recall$/ },
  // Skills
  { method: 'GET', pattern: /^\/api\/skills(?:\/top|\/suggestions|\/[^/]+\/content)?$/ },
  { method: 'GET', pattern: /^\/api\/skills\/browse\/github$/ },
  { method: 'GET', pattern: /^\/api\/skills\/search$/ },
  { method: 'GET', pattern: /^\/api\/skills\/[^/]+$/ },
  // Other reads
  { method: 'GET', pattern: /^\/api\/templates$/ },
  { method: 'GET', pattern: /^\/api\/graph\/stats$/ },
  { method: 'GET', pattern: /^\/api\/config$/ },
  { method: 'GET', pattern: /^\/api\/config\/model-capability$/ },
  { method: 'GET', pattern: /^\/api\/mcp\/tools$/ },
  { method: 'GET', pattern: /^\/api\/auth\/me$/ },
];

function isPublicTool(definition: Pick<McpToolDefinition, 'capturedMethod' | 'capturedPath'>): boolean {
  return PUBLIC_TOOL_RULES.some((rule) =>
    rule.method === definition.capturedMethod && rule.pattern.test(definition.capturedPath));
}

export function getMcpToolTier(definition: Pick<McpToolDefinition, 'capturedMethod' | 'capturedPath' | 'capturedOperation'>): McpTier {
  // OpenAPI is the authority for auth/public MCP eligibility. Preserve the
  // legacy public allowlist for unannotated historic endpoints, but do not turn
  // a governed auth-tier route into an accidental admin-only dead end.
  const declaredTier = getRorcaTier(definition.capturedOperation).tier;
  if (declaredTier === 'public' || declaredTier === 'auth') return 'public';
  return isPublicTool(definition) ? 'public' : 'admin';
}

export function buildMcpToolTierResolver(spec: OpenAPISpec): (toolName: string) => McpTier {
  const definitions = getMcpToolDefinitions(spec);
  const toolTierMap = new Map(definitions.map((definition) => [definition.toolName, getMcpToolTier(definition)]));
  const definitionByRoute = new Map(definitions.map((definition) => [`${definition.capturedMethod} ${definition.capturedPath}`, definition]));

  for (const alias of MCP_FRIENDLY_ALIASES) {
    const definition = definitionByRoute.get(`${alias.method} ${alias.path}`);
    if (!definition) continue;
    toolTierMap.set(alias.toolName, getMcpToolTier(definition));
  }

  return (toolName: string) => CUSTOM_SESSION_TOOL_TIERS[toolName]
    ?? toolTierMap.get(toolName) ?? 'admin';
}

// ─── Tool name generation ───────────────────────────────────────────────────

function generateToolName(method: string, path: string, allPaths: Map<string, string[]>): string {
  let segments = path.replace(/^\/api\//, '').split('/').filter(Boolean);

  segments = segments.map(s => {
    if (s.startsWith('{') && s.endsWith('}')) {
      return 'by_' + s.slice(1, -1);
    }
    return s;
  });

  let name = segments.join('_').replace(/-/g, '_');

  const methods = allPaths.get(path) || [method];
  if (methods.length > 1) {
    name = `${method.toLowerCase()}_${name}`;
  }

  return `rorca_${name}`;
}

// ─── OpenAPI → Zod schema conversion ────────────────────────────────────────

function openApiTypeToZod(prop: OpenAPIPropertySchema, required: boolean): z.ZodType {
  let schema: z.ZodType;

  if (prop.$ref) {
    let refSchema: z.ZodType = z.record(z.string(), z.unknown());
    if (prop.description) refSchema = refSchema.describe(prop.description);
    return required ? refSchema : refSchema.optional();
  }

  switch (prop.type) {
    case 'integer':
    case 'number': {
      let numSchema = prop.type === 'integer' ? z.number().int() : z.number();
      if (prop.minimum !== undefined) numSchema = numSchema.min(prop.minimum);
      if (prop.maximum !== undefined) numSchema = numSchema.max(prop.maximum);
      if (prop.description) numSchema = numSchema.describe(prop.description);
      schema = numSchema;
      break;
    }
    case 'boolean': {
      let boolSchema = z.boolean();
      if (prop.description) boolSchema = boolSchema.describe(prop.description);
      schema = boolSchema;
      break;
    }
    case 'object': {
      let objectSchema: z.ZodType;
      if (prop.properties) {
        const baseObject = z.object(Object.fromEntries(
          Object.entries(prop.properties).map(([key, child]) => [key, openApiTypeToZod(child, false)]),
        ));
        objectSchema = prop.additionalProperties === false ? baseObject.strict() : baseObject.passthrough();
      } else if (prop.additionalProperties && typeof prop.additionalProperties === 'object') {
        objectSchema = z.record(z.string(), openApiTypeToZod(prop.additionalProperties, true));
      } else {
        objectSchema = z.record(z.string(), z.unknown());
      }
      if (prop.description) objectSchema = objectSchema.describe(prop.description);
      schema = objectSchema;
      break;
    }
    case 'array': {
      let itemSchema: z.ZodType;
      if (prop.items) {
        itemSchema = openApiTypeToZod(prop.items, true);
      } else {
        itemSchema = z.unknown();
      }
      let arrSchema = z.array(itemSchema);
      if (prop.minItems !== undefined) arrSchema = arrSchema.min(prop.minItems);
      if (prop.maxItems !== undefined) arrSchema = arrSchema.max(prop.maxItems);
      if (prop.description) arrSchema = arrSchema.describe(prop.description);
      schema = arrSchema;
      break;
    }
    default: {
      // string (default) — with optional enum
      if (prop.enum && prop.enum.length > 0) {
        const values = prop.enum.map(v => String(v)) as [string, ...string[]];
        let enumSchema = z.enum(values);
        if (prop.description) enumSchema = enumSchema.describe(prop.description);
        schema = enumSchema;
      } else {
        let strSchema = z.string();
        if (prop.minLength !== undefined) strSchema = strSchema.min(prop.minLength);
        if (prop.maxLength !== undefined) strSchema = strSchema.max(prop.maxLength);
        if (prop.pattern) strSchema = strSchema.regex(new RegExp(prop.pattern));
        if (prop.format === 'uuid') strSchema = strSchema.uuid();
        else if (prop.format === 'uri' || prop.format === 'url') strSchema = strSchema.url();
        else if (prop.format === 'date-time') strSchema = strSchema.datetime({ offset: true });
        if (prop.description) strSchema = strSchema.describe(prop.description);
        schema = strSchema;
      }
      break;
    }
  }

  if (!required) {
    schema = schema.optional();
  }

  return schema;
}

function collectInputSchemaParts(operation: OpenAPIOperation): {
  properties: Record<string, OpenAPIPropertySchema>;
  requiredParams: string[];
} {
  const properties: Record<string, OpenAPIPropertySchema> = {};
  const requiredParams = new Set<string>();
  const requiredBodyFields = new Set<string>();

  const jsonContent = operation.requestBody?.content?.['application/json'];
  if (jsonContent?.schema?.required) {
    for (const r of jsonContent.schema.required) {
      requiredBodyFields.add(r);
    }
  }

  if (operation.parameters) {
    for (const param of operation.parameters) {
      if (param.in === 'cookie') continue;
      if (param.in === 'header') {
        if (param.name.toLowerCase() !== 'idempotency-key') continue;
        properties.idempotencyKey = {
          ...(param.schema ?? {}),
          type: param.schema?.type || 'string',
          description: param.description || param.schema?.description,
        };
        if (param.required === true) requiredParams.add('idempotencyKey');
        continue;
      }
      properties[param.name] = {
        ...(param.schema ?? {}),
        type: param.schema?.type || 'string',
        description: param.description || param.schema?.description,
      };

      if (param.required === true && param.name !== 'workspaceId') {
        requiredParams.add(param.name);
      }
    }
  }

  if (jsonContent?.schema?.properties) {
    for (const [propName, propSchema] of Object.entries(jsonContent.schema.properties)) {
      properties[propName] = { ...propSchema };
      if (requiredBodyFields.has(propName)) {
        requiredParams.add(propName);
      }
    }
  }

  const formContent = operation.requestBody?.content?.['multipart/form-data'];
  if (formContent?.schema?.properties) {
    for (const [propName, propSchema] of Object.entries(formContent.schema.properties)) {
      properties[propName] = { ...propSchema };
    }
  }

  return {
    properties,
    requiredParams: Array.from(requiredParams),
  };
}

function buildZodInputShape(
  operation: OpenAPIOperation,
): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  const { properties, requiredParams } = collectInputSchemaParts(operation);
  const requiredSet = new Set(requiredParams);

  for (const [propName, propSchema] of Object.entries(properties)) {
    shape[propName] = openApiTypeToZod(propSchema, requiredSet.has(propName));
  }

  return shape;
}

function inferMcpToolCategory(definition: Pick<McpToolDefinition, 'capturedPath' | 'capturedOperation'>): string {
  const firstTag = definition.capturedOperation.tags?.[0]?.trim();
  if (firstTag) {
    const lower = firstTag.toLowerCase();
    if (lower === 'pipeline' || lower === 'specs') return 'Specs & Pipeline';
    if (lower === 'direction') return 'Direction Stack';
    if (lower === 'memory' || lower === 'recall') return 'Memory';
    if (lower === 'workspace' || lower === 'workspaces') return 'Workspaces';
    return firstTag;
  }

  if (definition.capturedPath.startsWith('/api/specs') || definition.capturedPath.startsWith('/api/pipeline')) return 'Specs & Pipeline';
  if (definition.capturedPath.startsWith('/api/direction')) return 'Direction Stack';
  if (definition.capturedPath.startsWith('/api/workspaces')) return 'Workspaces';
  if (definition.capturedPath.startsWith('/api/memory') || definition.capturedPath.startsWith('/api/recall')) return 'Memory';

  const segment = definition.capturedPath.replace(/^\/api\//, '').split('/')[0] || 'Other';
  return segment
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export const MCP_FRIENDLY_ALIASES: readonly McpFriendlyAlias[] = [
  {
    toolName: 'rorca_get_context',
    description: 'Friendly alias for direction-stack synthesis when a caller needs project context before drafting.',
    method: 'POST',
    path: '/api/direction/synthesize',
  },
  {
    toolName: 'rorca_generate_spec',
    description: 'Friendly alias for legacy/fallback brief-to-spec generation where Rorca does the drafting.',
    method: 'POST',
    path: '/api/specs/generate',
  },
  {
    toolName: 'rorca_create_spec',
    description: 'Canonical explicit spec-creation alias: create a Rorca spec from caller-drafted content via backend validation and persistence.',
    method: 'POST',
    path: '/api/specs/persist',
  },
  {
    toolName: 'rorca_persist_spec',
    description: 'Compatibility alias for explicit spec persistence; prefer rorca_create_spec as the cross-client command/tool name.',
    method: 'POST',
    path: '/api/specs/persist',
  },
  {
    toolName: 'rorca_get_spec_export_kit',
    description: 'Read and verify the current deterministic PRD/SDD/PLAN export kit for a canonical spec revision.',
    method: 'GET',
    path: '/api/specs/{specId}/export-kit',
  },
  {
    toolName: 'rorca_get_spec_export_kit_artifact',
    description: 'Read one verified artifact from the current deterministic spec export kit.',
    method: 'GET',
    path: '/api/specs/{specId}/export-kit/artifacts/{role}',
  },
  {
    toolName: 'rorca_rebuild_spec_export_kit',
    description: 'Explicitly rebuild a missing legacy spec export kit; never silently reseals or overwrites an existing generation.',
    method: 'POST',
    path: '/api/specs/{specId}/export-kit/rebuild',
  },
  {
    toolName: 'rorca_spec_workflow',
    description: 'Inspect the durable post-save workflow state for a single spec.',
    method: 'GET',
    path: '/api/specs/{specId}/workflow',
  },
  {
    toolName: 'rorca_spec_readiness',
    description: 'Inspect execution readiness, reason codes, and safe action hints for a single spec.',
    method: 'GET',
    path: '/api/specs/{specId}/readiness',
  },
  {
    toolName: 'rorca_retry_spec_stage',
    description: 'Retry a single durable post-save workflow stage for a spec.',
    method: 'POST',
    path: '/api/specs/{specId}/workflow/stages/{stageKey}/retry',
  },
  {
    toolName: 'rorca_repair_spec',
    description: 'Diagnose and repair durable post-save state for a single spec.',
    method: 'POST',
    path: '/api/specs/{specId}/repair',
  },
  {
    toolName: 'rorca_repair_spec_batch',
    description: 'Diagnose and repair a bounded batch of specs in one workspace.',
    method: 'POST',
    path: '/api/specs/repair-batch',
  },
  {
    toolName: 'rorca_list_specs',
    description: 'Friendly alias for listing specs in a workspace.',
    method: 'GET',
    path: '/api/specs',
  },
  {
    toolName: 'rorca_approve_spec',
    description: 'Friendly alias for approving a pending spec.',
    method: 'POST',
    path: '/api/specs/{specId}/approve',
  },
  {
    toolName: 'rorca_pipeline_status',
    description: 'Friendly alias for listing recent pipeline runs and their current status.',
    method: 'GET',
    path: '/api/pipeline/runs',
  },
  {
    toolName: 'rorca_list_workspaces',
    description: 'Friendly alias for listing visible workspaces.',
    method: 'GET',
    path: '/api/workspaces',
  },
  {
    toolName: 'rorca_preflight_run',
    description: 'Preflight an approved spec run, inspect the human-readable compatibility report, and obtain the canonical short-lived binding required by rorca_trigger_run.',
    method: 'POST',
    path: '/api/pipeline/preflight',
  },
  {
    toolName: 'rorca_trigger_run',
    description: 'Trigger an approved spec run using the exact previewHash and previewExpiresAt returned by rorca_preflight_run plus a stable caller-owned idempotencyKey.',
    method: 'POST',
    path: '/api/pipeline/trigger',
  },
  {
    toolName: 'rorca_trigger_task_manifest',
    description: 'Friendly alias for triggering bounded Hermes task-manifest execution through the Rorca pipeline broker.',
    method: 'POST',
    path: '/api/pipeline/task-manifests/trigger',
  },
  {
    toolName: 'rorca_run_status',
    description: 'Friendly alias for loading detailed status for a single pipeline run.',
    method: 'GET',
    path: '/api/pipeline/runs/{runId}',
  },
  {
    toolName: 'rorca_retry_story',
    description: 'Friendly alias for retrying failed stories from a prior pipeline run.',
    method: 'POST',
    path: '/api/pipeline/runs/{runId}/retry',
  },
  {
    toolName: 'rorca_list_runs',
    description: 'Friendly alias for listing pipeline runs in a workspace.',
    method: 'GET',
    path: '/api/pipeline/runs',
  },
  {
    toolName: 'rorca_edit_story',
    description: 'Friendly alias for editing a single story inside a spec.',
    method: 'PATCH',
    path: '/api/specs/{specId}/stories/{storyId}',
  },
  {
    toolName: 'rorca_search_stories',
    description: 'Friendly alias for cross-spec story search.',
    method: 'GET',
    path: '/api/specs/search/stories',
  },
  {
    toolName: 'rorca_add_stories',
    description: 'Friendly alias for appending generated stories to a spec.',
    method: 'POST',
    path: '/api/specs/{specId}/add-stories',
  },
  {
    toolName: 'rorca_delete_story',
    description: 'Friendly alias for deleting a story from a spec.',
    method: 'DELETE',
    path: '/api/specs/{specId}/stories/{storyId}',
  },
  {
    toolName: 'rorca_enrich_spec',
    description: 'Legacy alias for spec enrichment via the async spec-job bridge.',
    method: 'POST',
    path: '/api/specs/{specId}/enrich',
  },
  {
    toolName: 'rorca_match_skills',
    description: 'Legacy alias for spec skill matching via the async spec-job bridge.',
    method: 'POST',
    path: '/api/specs/{specId}/match-skills/async',
  },
  {
    toolName: 'rorca_suggest_skills',
    description: 'Legacy alias for spec skill suggestions via the async spec-job bridge.',
    method: 'POST',
    path: '/api/specs/{specId}/suggest-skills/async',
  },
  {
    toolName: 'rorca_save_memory',
    description: 'Friendly alias for saving a memory entry to the workspace ledger.',
    method: 'POST',
    path: '/api/memory',
  },
  {
    toolName: 'rorca_get_memories',
    description: 'Friendly alias for browsing paginated memory entries for a workspace.',
    method: 'GET',
    path: '/api/memory/items',
  },
  {
    toolName: 'rorca_share_memory',
    description: 'Friendly alias for sharing a memory entry into another workspace (retrievable there without duplication).',
    method: 'POST',
    path: '/api/memory/{id}/share',
  },
  {
    toolName: 'rorca_unshare_memory',
    description: 'Friendly alias for removing a memory share from a workspace.',
    method: 'DELETE',
    path: '/api/memory/{id}/share/{workspaceId}',
  },
  {
    toolName: 'rorca_memory_shares',
    description: 'Friendly alias for listing the workspaces a memory is shared into.',
    method: 'GET',
    path: '/api/memory/{id}/shares',
  },
] as const;

export function getPublishedMcpTools(spec: OpenAPISpec): PublishedMcpTool[] {
  const definitions = getMcpToolDefinitions(spec);
  const tools: PublishedMcpTool[] = definitions.map((definition) => {
    const { properties, requiredParams } = collectInputSchemaParts(definition.capturedOperation);
    return {
      name: definition.toolName,
      description: definition.description,
      category: inferMcpToolCategory(definition),
      inputSchema: properties,
      requiredParams,
    };
  });

  const definitionByRoute = new Map(definitions.map((definition) => [`${definition.capturedMethod} ${definition.capturedPath}`, definition]));
  for (const alias of MCP_FRIENDLY_ALIASES) {
    const definition = definitionByRoute.get(`${alias.method} ${alias.path}`);
    if (!definition) continue;

    const { properties, requiredParams } = collectInputSchemaParts(definition.capturedOperation);
    tools.push({
      name: alias.toolName,
      description: alias.description,
      category: inferMcpToolCategory(definition),
      inputSchema: properties,
      requiredParams,
    });
  }

  // W5-009: omp provenance tools ported from main (omp-subagent:<agent>).
  tools.push(
    {
      name: 'rorca_select_workspace',
      description: 'Select a Rorca workspace by id, label, or path for the rest of this MCP session. Call again at any time to switch.',
      category: 'Workspaces',
      inputSchema: { workspace: { type: 'string', description: 'Exact workspace id, label, or path.' } },
      requiredParams: ['workspace'],
    },
    {
      name: 'rorca_current_workspace',
      description: 'Return the workspace currently selected for this MCP session.',
      category: 'Workspaces',
      inputSchema: {},
      requiredParams: [],
    },
    {
      name: 'rorca_record_subagent_run',
      description: 'Post the durable result of one completed OMP subagent run to the workspace selected for this MCP session. OMP should call this after every subagent completion.',
      category: 'Memory',
      inputSchema: {
        title: { type: 'string', description: 'Short durable-memory title.' },
        summary: { type: 'string', description: 'Reusable result, decision, convention, bug fix, pattern, or gotcha learned by the subagent.' },
        agent: { type: 'string', description: 'Subagent name or role.' },
        outcome: { type: 'string', enum: ['completed', 'failed'], default: 'completed' },
        category: { type: 'string', enum: ['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha'], default: 'Pattern' },
        relatedFiles: { type: 'array', items: { type: 'string' } },
      },
      requiredParams: ['title', 'summary'],
    },
    {
      name: RUN_EVENT_SUBSCRIPTION_TOOL_NAMES[0],
      description: 'Subscribe this stateful OMP session to replayed and live canonical run WAL/SSE events for its selected workspace.',
      category: 'Specs & Pipeline',
      inputSchema: { afterEventId: { type: 'integer', minimum: 0, default: 0, description: 'Last canonical WAL event id already processed.' } },
      requiredParams: [],
    },
    {
      name: RUN_EVENT_SUBSCRIPTION_TOOL_NAMES[1],
      description: 'Stop canonical run-event notifications for this OMP session.',
      category: 'Specs & Pipeline',
      inputSchema: {},
      requiredParams: [],
    },
  );

  return tools;
}

// ─── Route filtering ────────────────────────────────────────────────────────

const SKIP_PATHS = new Set([
  '/api/health',
  '/api/health/detailed',
  '/api/pipeline/runs/{runId}/output',
  '/api/pipeline/stream',
]);

function shouldSkipRoute(_method: string, path: string): boolean {
  if (SKIP_PATHS.has(path)) return true;
  if (path.includes('/callback')) return true;
  return false;
}

// ─── Execute API call ───────────────────────────────────────────────────────

function extractPathParams(template: string): string[] {
  return (template.match(/\{(\w+)\}/g) || []).map(s => s.slice(1, -1));
}

// Cache the default workspace ID so we don't query on every tool call
let cachedDefaultWorkspaceId: string | null = null;
let cacheExpiry = 0;

async function getDefaultWorkspaceId(): Promise<string | null> {
  if (cachedDefaultWorkspaceId && Date.now() < cacheExpiry) return cachedDefaultWorkspaceId;
  try {
    const res = await fetch(`${RORCA_API}/api/workspaces?limit=1`);
    if (!res.ok) return null;
    const data = await res.json() as { items?: Array<{ id: string }> };
    cachedDefaultWorkspaceId = data.items?.[0]?.id ?? null;
    cacheExpiry = Date.now() + 60_000; // 1 min cache
    return cachedDefaultWorkspaceId;
  } catch { return null; }
}

// ─── Session-scoped workspace selection (ported from main, W5-009) ──────────
// The rorca_select_workspace / rorca_current_workspace / rorca_record_subagent_run
// tools let omp subagents pin a workspace per MCP session and post durable
// subagent-run memory with `omp-subagent:<agent>` provenance.

interface WorkspaceSummary {
  id: string;
  label?: string;
  path?: string;
}

const workspaceSummarySchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  path: z.string().optional(),
}).passthrough();

const workspaceListSchema = z.object({
  items: z.array(workspaceSummarySchema).optional(),
  workspaces: z.array(workspaceSummarySchema).optional(),
}).passthrough();

const sessionWorkspaceIds = new Map<string, string>();
const sessionRunEventSubscriptions = new Map<string, RunEventSubscription>();
const sessionPrincipals = new Map<string, string>();
const sessionWorkspaceAllowlists = new Map<string, readonly string[]>();

interface McpToolExtra {
  requestId?: string | number;
  sessionId?: string;
}

function getMcpSessionKey(extra: McpToolExtra | undefined, options: McpHttpServerOptions): string | undefined {
  return extra?.sessionId ?? options.defaultSessionId;
}

/**
 * Resolve a workspace selection and reauthorize membership against the
 * session's workspace allowlist on every selection. A session with an
 * allowlist may only select a workspace it is bound to; a session with an
 * empty allowlist is denied (fail closed).
 */
async function resolveWorkspaceSelection(query: string, allowlist?: readonly string[]): Promise<WorkspaceSummary> {
  const response = await fetchJsonWithTimeout(`${RORCA_API}/api/workspaces?limit=250`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }, 30_000);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Unable to list Rorca workspaces (${response.status})`);
  }
  const parsed = workspaceListSchema.safeParse(response.body);
  if (!parsed.success) {
    throw new Error('Rorca returned an invalid workspace list');
  }
  const workspaces = parsed.data.items ?? parsed.data.workspaces ?? [];
  const normalized = query.trim().toLocaleLowerCase();
  const matches = workspaces.filter((workspace) =>
    workspace.id.toLocaleLowerCase() === normalized
    || workspace.label?.toLocaleLowerCase() === normalized
    || workspace.path?.toLocaleLowerCase() === normalized);
  if (matches.length === 0) {
    throw new Error(`Workspace not found: ${query}`);
  }
  if (matches.length > 1) {
    throw new Error(`Workspace selection is ambiguous: ${query}. Use the workspace id.`);
  }
  const selected = matches[0]!;
  assertWorkspaceAuthorized(selected.id, allowlist);
  return selected;
}

function assertWorkspaceAuthorized(workspaceId: string, allowlist?: readonly string[]): void {
  if (allowlist !== undefined) {
    const allowed = allowlist.some((id) => id === workspaceId);
    if (!allowed) {
      throw new Error(`Workspace is not authorized for this MCP session: ${workspaceId}`);
    }
  }
}

function getSessionPrincipal(sessionKey: string | undefined, options: McpHttpServerOptions): string | undefined {
  if (!sessionKey) return undefined;
  return options.resolveSessionPrincipal?.(sessionKey) ?? sessionPrincipals.get(sessionKey);
}

function getSessionWorkspaceAllowlist(sessionKey: string | undefined, options: McpHttpServerOptions): readonly string[] | undefined {
  if (!sessionKey) return undefined;
  return options.resolveSessionWorkspaceAllowlist?.(sessionKey) ?? sessionWorkspaceAllowlists.get(sessionKey);
}

interface SessionCapabilityContext {
  readonly sessionKey: string | undefined;
  readonly principal: string | undefined;
  readonly workspaceAllowlist: readonly string[] | undefined;
  readonly selectedWorkspaceId: string | undefined;
}

/** Forward the session's scoped capability to internal Rorca APIs. */
function scopedCapabilityHeaders(context: SessionCapabilityContext): Record<string, string> {
  const headers: Record<string, string> = {};
  if (context.principal) headers['X-Rorca-Mcp-Principal'] = context.principal;
  if (context.selectedWorkspaceId) {
    headers['X-Rorca-Mcp-Workspace-Scope'] = `workspace:${context.selectedWorkspaceId}`;
  }
  return headers;
}

function collectSessionContext(extra: McpToolExtra | undefined, options: McpHttpServerOptions): SessionCapabilityContext {
  const sessionKey = getMcpSessionKey(extra, options);
  const selectedWorkspaceId = sessionKey ? sessionWorkspaceIds.get(sessionKey) : undefined;
  return Object.freeze({
    sessionKey,
    principal: getSessionPrincipal(sessionKey, options),
    workspaceAllowlist: getSessionWorkspaceAllowlist(sessionKey, options),
    selectedWorkspaceId,
  });
}

export function clearMcpSessionWorkspace(sessionId: string): void {
  sessionRunEventSubscriptions.get(sessionId)?.stop();
  sessionRunEventSubscriptions.delete(sessionId);
  sessionWorkspaceIds.delete(sessionId);
  sessionPrincipals.delete(sessionId);
  sessionWorkspaceAllowlists.delete(sessionId);
}
const ASYNC_SPEC_JOB_SUFFIXES = ['/enrich', '/match-skills', '/suggest-skills'] as const;
const SLOW_PREFIXES = ['/api/specs/generate', '/api/specs/generate-batch', '/api/workspaces/', '/api/admin/embed-all'];
const SLOW_SUFFIXES = ['/enrich', '/match-skills', '/suggest-skills', '/add-stories', '/knowledge-graph', '/hydrate', '/scan-direction', '/echolocate', '/discover', '/import', '/detect-dependencies', '/assign-models', '/suggest-models'];

function isSlowPath(resolvedPath: string): boolean {
  return (
    SLOW_PREFIXES.some(p => resolvedPath.startsWith(p)) ||
    SLOW_SUFFIXES.some(s => resolvedPath.endsWith(s) || resolvedPath.includes(`${s}?`) || resolvedPath.includes(`${s}/`))
  );
}

function shouldUseAsyncSpecJob(method: string, resolvedPath: string): boolean {
  return method === 'POST'
    && !resolvedPath.endsWith('/async')
    && ASYNC_SPEC_JOB_SUFFIXES.some(suffix => resolvedPath.endsWith(suffix));
}

function isAsyncSpecJobEndpoint(method: string, resolvedPath: string): boolean {
  return method === 'POST' && resolvedPath.endsWith('/async');
}

function getEnqueuedSpecJobId(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const payload = body as { jobId?: string; pollUrl?: string };
  if (!payload.jobId || !payload.pollUrl) {
    return null;
  }
  if (!payload.pollUrl.startsWith('/api/spec-jobs/')) {
    return null;
  }
  return payload.jobId;
}

async function readFetchBody(fetchRes: Awaited<ReturnType<typeof fetch>>): Promise<unknown> {
  const contentType = fetchRes.headers.get('content-type') || '';
  return contentType.includes('application/json')
    ? await fetchRes.json()
    : await fetchRes.text();
}

async function fetchJsonWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchRes = await fetch(url, { ...options, signal: controller.signal });
    return {
      status: fetchRes.status,
      body: await readFetchBody(fetchRes),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function mapTerminalSpecJobState(job: SpecJobState): { status: number; body: unknown } {
  if (job.status === 'completed') {
    return { status: 200, body: job.result };
  }

  const message = job.error || `Spec job ${job.id} ${job.status}`;
  const isNonFailureTerminal = job.status === 'cancelled' || job.status === 'superseded';
  return {
    status: isNonFailureTerminal ? 409 : 500,
    body: {
      error: message,
      code: job.status === 'superseded' ? 'SPEC_JOB_SUPERSEDED' : job.status === 'cancelled' ? 'SPEC_JOB_CANCELLED' : 'SPEC_JOB_FAILED',
      jobId: job.id,
      status: job.status,
    },
  };
}

async function executeApiCall(
  method: string,
  pathTemplate: string,
  params: Record<string, unknown>,
  operation?: OpenAPIOperation,
  sessionContext?: SessionCapabilityContext,
): Promise<{ status: number; body: unknown }> {
  // Clone before injection so the caller's params object is never mutated.
  const scopedParams = { ...params };
  // Auto-inject workspaceId when required but not provided — the session's
  // selected workspace wins over the default, so a session-bound principal
  // stays inside its allowlisted workspace.
  const requiredParams = (operation?.parameters || []).filter(p => p.required);
  for (const rp of requiredParams) {
    if (rp.name === 'workspaceId' && !scopedParams.workspaceId) {
      const selectedId = sessionContext?.selectedWorkspaceId;
      if (selectedId) {
        scopedParams.workspaceId = selectedId;
      } else {
        const defaultId = await getDefaultWorkspaceId();
        if (defaultId) scopedParams.workspaceId = defaultId;
      }
    }
  }

  let resolvedPath = pathTemplate;
  const queryParams: Record<string, string> = {};
  const bodyParams: Record<string, unknown> = {};
  const pathParamNames = extractPathParams(pathTemplate);

  for (const [key, value] of Object.entries(scopedParams)) {
    if (value === undefined || value === null) continue;

    if (pathParamNames.includes(key)) {
      resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(String(value)));
    } else if (method === 'GET' || method === 'DELETE') {
      queryParams[key] = String(value);
    } else {
      bodyParams[key] = value;
    }
  }

  let url = `${RORCA_API}${resolvedPath}`;
  const qsEntries = Object.entries(queryParams);
  if (qsEntries.length > 0) {
    url += `?${new URLSearchParams(qsEntries).toString()}`;
  }
  const asyncUrl = `${RORCA_API}${resolvedPath}/async${qsEntries.length > 0 ? `?${new URLSearchParams(qsEntries).toString()}` : ''}`;

  const idempotencyKeyHeaderRequired = operation?.parameters?.some(
    (parameter) => parameter.in === 'header'
      && parameter.name.toLowerCase() === 'idempotency-key'
      && parameter.required === true,
  ) === true;
  const idempotencyKey = typeof scopedParams.idempotencyKey === 'string'
    ? scopedParams.idempotencyKey.trim()
    : '';
  if (idempotencyKeyHeaderRequired && !idempotencyKey) {
    throw new Error('idempotencyKey is required for this operation');
  }

  const fetchOptions: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionContext ? scopedCapabilityHeaders(sessionContext) : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
  };


  if (method !== 'GET' && method !== 'DELETE' && Object.keys(bodyParams).length > 0) {
    fetchOptions.body = JSON.stringify(bodyParams);
  }

  if (shouldUseAsyncSpecJob(method, resolvedPath)) {
    const enqueue = await fetchJsonWithTimeout(asyncUrl, fetchOptions, 30_000);
    const jobId = getEnqueuedSpecJobId(enqueue.body);
    if (enqueue.status < 200 || enqueue.status >= 300 || !jobId) {
      return enqueue;
    }

    const finalState = await pollSpecJob(jobId, {
      intervalMs: 2_000,
      maxWaitMs: 1_800_000,
    });
    return mapTerminalSpecJobState(finalState);
  }

  if (isAsyncSpecJobEndpoint(method, resolvedPath)) {
    const enqueue = await fetchJsonWithTimeout(url, fetchOptions, 30_000);
    const jobId = getEnqueuedSpecJobId(enqueue.body);
    if (enqueue.status < 200 || enqueue.status >= 300 || !jobId) {
      return enqueue;
    }

    const finalState = await pollSpecJob(jobId, {
      intervalMs: 2_000,
      maxWaitMs: 1_800_000,
    });
    return mapTerminalSpecJobState(finalState);
  }

  // Slow paths run with a generous timeout (10 min). Fast paths get 30s.
  // For enrich/match-skills/suggest-skills, the async spec-job bridge above
  // handles those via the /async endpoint — this fallback covers any other slow ops.
  const timeoutMs = isSlowPath(resolvedPath) ? 10 * 60 * 1000 : 30_000;
  return fetchJsonWithTimeout(url, fetchOptions, timeoutMs);
}

// ─── Create MCP server with auto-generated tools ────────────────────────────

export function getMcpToolDefinitions(spec: OpenAPISpec): McpToolDefinition[] {
  const allPaths = new Map<string, string[]>();
  for (const [pathStr, methods] of Object.entries(spec.paths)) {
    allPaths.set(pathStr, Object.keys(methods).map(m => m.toUpperCase()));
  }

  const definitions: McpToolDefinition[] = [];

  for (const [pathStr, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      // Some operator-only REST operations must never be callable through MCP,
      // including by an MCP admin token.
      if (operation['x-rorca-mcp'] === false) continue;
      const { tier } = getRorcaTier(operation);
      const mcpOverride = getMcpExposureOverride(operation);
      if (!tierAllowedFromMcp(tier) && !mcpOverride) continue;

      const httpMethod = method.toUpperCase();
      if (shouldSkipRoute(httpMethod, pathStr)) continue;

      definitions.push({
        toolName: generateToolName(httpMethod, pathStr, allPaths),
        description: operation.summary || operation.description || `${httpMethod} ${pathStr}`,
        zodShape: buildZodInputShape(operation),
        capturedMethod: httpMethod,
        capturedPath: pathStr,
        capturedOperation: operation,
      });
    }
  }

  return definitions;
}

export function createMcpHttpServer(spec: OpenAPISpec, options: McpHttpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'rorca-http',
    version: '2.0.0',
  });

  const definitions = getMcpToolDefinitions(spec);
  const registerDefinition = (
    definition: McpToolDefinition,
    overrides?: { toolName?: string; description?: string },
  ) => {
    const toolName = overrides?.toolName ?? definition.toolName;
    const description = overrides?.description ?? definition.description;
    const { zodShape, capturedMethod, capturedPath, capturedOperation } = definition;
    const hasParams = Object.keys(zodShape).length > 0;
    const handler = async (params: Record<string, unknown>, extra?: { requestId?: string | number; sessionId?: string }) => {
      const requiredTier = getMcpToolTier(definition);
      const tokenTier = options.resolveSessionTier?.(extra?.sessionId);
      const remoteAddr = options.getSessionRemoteAddr?.(extra?.sessionId);
      const sessionContext = collectSessionContext(extra as McpToolExtra | undefined, options);
      if (requiredTier === 'admin' && tokenTier !== 'admin') {
        return {
          content: [{ type: 'text' as const, text: 'Error: This tool requires admin tier' }],
          isError: true,
        };
      }

      const effectiveTokenTier = tokenTier ?? 'public';
      const startMs = Date.now();
      const hashedParams = paramsHash(params);
      const rateLimit = consumeMcpRateLimit(toolName, effectiveTokenTier);
      if (!rateLimit.allowed) {
        const retryAfterSeconds = rateLimit.retryAfterSeconds ?? 60;
        recordMcpCall({
          toolName,
          tokenTier: effectiveTokenTier,
          remoteAddr,
          sessionId: extra?.sessionId,
          paramsHash: hashedParams,
          params,
          success: false,
          errorCode: 'MCP_RATE_LIMITED',
          durationMs: Date.now() - startMs,
        }).catch((err) => logger.warn({ err }, '[MCP Audit] Failed to record call'));

        return {
          content: [{
            type: 'text' as const,
            text: `Error (429): ${JSON.stringify({
              error: 'MCP tool rate limit exceeded',
              code: 'MCP_RATE_LIMITED',
              retryAfterSeconds,
            }, null, 2)}`,
          }],
          isError: true,
          _meta: {
            httpStatus: 429,
            headers: {
              'Retry-After': String(retryAfterSeconds),
            },
          },
        };
      }

      try {
        const { status, body } = await executeApiCall(capturedMethod, capturedPath, { ...params }, capturedOperation, sessionContext);
        recordMcpCall({
          toolName,
          tokenTier: effectiveTokenTier,
          remoteAddr,
          sessionId: extra?.sessionId,
          paramsHash: hashedParams,
          params,
          success: status < 400,
          errorCode: status >= 400 ? extractErrorCode(body) : null,
          durationMs: Date.now() - startMs,
        }).catch((err) => logger.warn({ err }, '[MCP Audit] Failed to record call'));

        if (status >= 400) {
          const errorText = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
          const safeError = errorText.length > MAX_INLINE_CHARS
            ? spillLargeResult(toolName, body, errorText)
            : errorText;
          return {
            content: [{ type: 'text' as const, text: `Error (${status}): ${safeError}` }],
            isError: true,
          };
        }

        const resultText = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
        const safeResult = resultText.length > MAX_INLINE_CHARS
          ? spillLargeResult(toolName, body, resultText)
          : resultText;
        logger.info({
          timestamp: new Date().toISOString(),
          toolName,
          tokenTier: effectiveTokenTier,
          success: true,
          ...(effectiveTokenTier === 'admin'
            ? {
                sessionId: extra?.sessionId,
                requestId: extra?.requestId,
                method: capturedMethod,
                path: capturedPath,
              }
            : {}),
        }, '[MCP Audit] Tool call succeeded');
        return {
          content: [{ type: 'text' as const, text: safeResult }],
        };
      } catch (err: unknown) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        const message = isAbort
          ? `Tool timed out. This is a long-running operation — the backend is still processing. Check results via the relevant list/get tool after a moment.`
          : err instanceof Error ? err.message : String(err);
        recordMcpCall({
          toolName,
          tokenTier: effectiveTokenTier,
          remoteAddr,
          sessionId: extra?.sessionId,
          paramsHash: hashedParams,
          params,
          success: false,
          errorCode: isAbort ? 'MCP_TOOL_TIMEOUT' : 'MCP_TOOL_ERROR',
          durationMs: Date.now() - startMs,
        }).catch((auditErr) => logger.warn({ err: auditErr }, '[MCP Audit] Failed to record call'));
        return {
          content: [{ type: 'text' as const, text: `MCP tool error: ${message}` }],
          isError: true,
        };
      }
    };

    if (hasParams) {
      server.tool(toolName, description, zodShape, handler);
    } else {
      server.tool(toolName, description, handler);
    }
  };

  for (const definition of definitions) {
    registerDefinition(definition);
  }

  const definitionByRoute = new Map(definitions.map((definition) => [`${definition.capturedMethod} ${definition.capturedPath}`, definition]));

  let aliasCount = 0;
  for (const alias of MCP_FRIENDLY_ALIASES) {
    const definition = definitionByRoute.get(`${alias.method} ${alias.path}`);
    if (definition) {
      registerDefinition(definition, {
        toolName: alias.toolName,
        description: alias.description,
      });
      aliasCount += 1;
    }
  }

  // ─── W5-009: omp session tools (ported from main) ─────────────────────────
  const customResult = async (
    toolName: string,
    params: Record<string, unknown>,
    extra: McpToolExtra | undefined,
    action: () => Promise<unknown>,
  ) => {
    const requiredTier = CUSTOM_SESSION_TOOL_TIERS[toolName] ?? 'admin';
    const tokenTier = options.resolveSessionTier?.(extra?.sessionId) ?? 'public';
    if (requiredTier === 'admin' && tokenTier !== 'admin') {
      return {
        content: [{ type: 'text' as const, text: 'Error: This tool requires admin tier' }],
        isError: true,
      };
    }
    const remoteAddr = options.getSessionRemoteAddr?.(extra?.sessionId);
    const startedAt = Date.now();
    const hashedParams = paramsHash(params);
    const rateLimit = consumeMcpRateLimit(toolName, tokenTier);
    if (!rateLimit.allowed) {
      const retryAfterSeconds = rateLimit.retryAfterSeconds ?? 60;
      recordMcpCall({
        toolName,
        tokenTier,
        remoteAddr,
        sessionId: extra?.sessionId,
        paramsHash: hashedParams,
        params,
        success: false,
        errorCode: 'MCP_RATE_LIMITED',
        durationMs: Date.now() - startedAt,
      }).catch((err) => logger.warn({ err }, '[MCP Audit] Failed to record call'));
      return {
        content: [{
          type: 'text' as const,
          text: `Error (429): ${JSON.stringify({
            error: 'MCP tool rate limit exceeded',
            code: 'MCP_RATE_LIMITED',
            retryAfterSeconds,
          }, null, 2)}`,
        }],
        isError: true,
      };
    }
    try {
      const body = await action();
      recordMcpCall({
        toolName,
        tokenTier,
        remoteAddr,
        sessionId: extra?.sessionId,
        paramsHash: hashedParams,
        params,
        success: true,
        errorCode: null,
        durationMs: Date.now() - startedAt,
      }).catch((err) => logger.warn({ err }, '[MCP Audit] Failed to record call'));
      return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordMcpCall({
        toolName,
        tokenTier,
        remoteAddr,
        sessionId: extra?.sessionId,
        paramsHash: hashedParams,
        params,
        success: false,
        errorCode: 'MCP_TOOL_ERROR',
        durationMs: Date.now() - startedAt,
      }).catch((err) => logger.warn({ err }, '[MCP Audit] Failed to record call'));
      return {
        content: [{ type: 'text' as const, text: `MCP tool error: ${message}` }],
        isError: true,
      };
    }
  };

  server.tool(
    'rorca_select_workspace',
    'Select a Rorca workspace by exact id, label, or path for the rest of this MCP session. Call again at any time to switch. All later Rorca tools use it when workspaceId is omitted. OMP should call rorca_record_subagent_run after every subagent completion.',
    { workspace: z.string().min(1).describe('Exact workspace id, label, or path.') },
    async (params, extra) => customResult('rorca_select_workspace', params, extra as McpToolExtra | undefined, async () => {
      const sessionKey = getMcpSessionKey(extra as McpToolExtra | undefined, options);
      if (!sessionKey) {
        throw new Error('Workspace selection requires a stateful MCP session');
      }
      const workspace = await resolveWorkspaceSelection(
        params.workspace,
        getSessionWorkspaceAllowlist(sessionKey, options),
      );
      // A workspace switch must terminate the old stream before changing scope.
      sessionRunEventSubscriptions.get(sessionKey)?.stop();
      sessionRunEventSubscriptions.delete(sessionKey);
      sessionWorkspaceIds.set(sessionKey, workspace.id);
      return {
        selected: workspace,
        sessionScoped: true,
        subagentMemory: 'Call rorca_record_subagent_run after every OMP subagent completion.',
      };
    }),
  );

  server.tool(
    'rorca_current_workspace',
    'Return the Rorca workspace selected for this MCP session.',
    async (extra) => customResult('rorca_current_workspace', {}, extra as McpToolExtra | undefined, async () => {
      const sessionKey = getMcpSessionKey(extra as McpToolExtra | undefined, options);
      const workspaceId = sessionKey ? sessionWorkspaceIds.get(sessionKey) : undefined;
      return workspaceId
        ? { workspaceId, sessionScoped: true }
        : { workspaceId: null, sessionScoped: Boolean(sessionKey), hint: 'Call rorca_select_workspace first.' };
    }),
  );

  server.tool(
    'rorca_record_subagent_run',
    'Post the durable result of one completed OMP subagent run to the selected Rorca workspace. OMP should call this exactly once after every subagent completion, and the user may switch the destination at any time with rorca_select_workspace.',
    {
      title: z.string().min(1).max(160),
      summary: z.string().min(1).max(12_000),
      agent: z.string().min(1).max(160).optional(),
      outcome: z.enum(['completed', 'failed']).default('completed'),
      category: z.enum(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']).default('Pattern'),
      relatedFiles: z.array(z.string()).max(50).optional(),
    },
    async (params, extra) => customResult('rorca_record_subagent_run', params, extra as McpToolExtra | undefined, async () => {
      const sessionKey = getMcpSessionKey(extra as McpToolExtra | undefined, options);
      const workspaceId = sessionKey ? sessionWorkspaceIds.get(sessionKey) : undefined;
      if (!workspaceId) {
        throw new Error('No workspace selected for this MCP session. Call rorca_select_workspace first.');
      }
      // Reauthorize membership on every write: the session allowlist is the
      // authority even if the selection happened before the allowlist changed.
      assertWorkspaceAuthorized(workspaceId, getSessionWorkspaceAllowlist(sessionKey, options));
      const sessionContext = collectSessionContext(extra as McpToolExtra | undefined, options);
      const { status, body } = await executeApiCall('POST', '/api/memory', {
        workspaceId,
        category: params.category,
        title: params.title,
        rule: params.summary,
        context: `OMP subagent ${params.agent ?? 'unknown'} finished with outcome ${params.outcome}.`,
        source: `omp-subagent:${params.agent ?? 'unknown'}`,
        sourceType: 'mcp',
        relatedFiles: params.relatedFiles ?? [],
      }, undefined, sessionContext);
      if (status < 200 || status >= 300) {
        throw new Error(`Rorca memory post failed (${status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
      }
      return { workspaceId, recorded: true, outcome: params.outcome, memory: body };
    }),
  );

  server.tool(
    'rorca_subscribe_run_events',
    'Subscribe this stateful OMP session to idempotent replay and live canonical WAL/SSE run, story, gate, evidence, orchestration.*, and gateway.* events for its selected workspace.',
    { afterEventId: z.number().int().nonnegative().default(0) },
    async (params, extra) => customResult('rorca_subscribe_run_events', params, extra as McpToolExtra | undefined, async () => {
      const sessionKey = getMcpSessionKey(extra as McpToolExtra | undefined, options);
      if (!sessionKey) throw new Error('Run-event subscription requires a stateful MCP session');
      const workspaceId = sessionWorkspaceIds.get(sessionKey);
      if (!workspaceId) throw new Error('No workspace selected for this MCP session. Call rorca_select_workspace first.');
      assertWorkspaceAuthorized(workspaceId, getSessionWorkspaceAllowlist(sessionKey, options));

      sessionRunEventSubscriptions.get(sessionKey)?.stop();
      const subscription = new RunEventSubscription(workspaceId, replayRunEvents, async (dispatch) => {
        // notifications/message is the standard MCP server-push channel. The
        // data contains the unchanged canonical WAL/SSE event envelope.
        await server.server.sendLoggingMessage({ level: 'info', logger: 'rorca.run-events', data: dispatch });
      });
      sessionRunEventSubscriptions.set(sessionKey, subscription);
      try {
        return await subscription.start(params.afterEventId);
      } catch (error) {
        if (sessionRunEventSubscriptions.get(sessionKey) === subscription) {
          sessionRunEventSubscriptions.delete(sessionKey);
        }
        throw error;
      }
    }),
  );

  server.tool(
    'rorca_unsubscribe_run_events',
    'Stop canonical run-event notifications for this OMP session.',
    async (extra) => customResult('rorca_unsubscribe_run_events', {}, extra as McpToolExtra | undefined, async () => {
      const sessionKey = getMcpSessionKey(extra as McpToolExtra | undefined, options);
      if (!sessionKey) throw new Error('Run-event unsubscription requires a stateful MCP session');
      const active = sessionRunEventSubscriptions.get(sessionKey);
      active?.stop();
      sessionRunEventSubscriptions.delete(sessionKey);
      return { unsubscribed: Boolean(active), canonicalToolNames: RUN_EVENT_SUBSCRIPTION_TOOL_NAMES };
    }),
  );

  logger.info(`[MCP-HTTP] Registered ${definitions.length} OpenAPI tools, ${aliasCount} friendly aliases, and ${Object.keys(CUSTOM_SESSION_TOOL_TIERS).length} session tools`);
  return server;
}

// ─── Transport session management ───────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();
const transportTiers = new Map<string, McpTier>();
const transportRemoteAddrs = new Map<string, string>();
const transportPrincipals = new Map<string, string>();
const transportWorkspaceAllowlists = new Map<string, readonly string[]>();

export function getMcpTransportCount(): number {
  return transports.size;
}

/**
 * Create Express-compatible request handlers for MCP HTTP at /mcp.
 * Supports POST (client→server), GET (SSE notifications), DELETE (session close).
 */
export function createMcpRequestHandler(spec: OpenAPISpec) {
  async function createTransport(
    remoteAddr: string,
    requestTier: McpTier | undefined,
    options: { stateful: boolean },
    principal?: string,
    workspaceAllowlist?: readonly string[],
  ): Promise<StreamableHTTPServerTransport> {
    let transport: StreamableHTTPServerTransport;
    const mcpServer = createMcpHttpServer(spec, {
      resolveSessionTier: (sid) => {
        if (sid) {
          return transportTiers.get(sid);
        }
        return requestTier;
      },
      getSessionRemoteAddr: (sid) => {
        if (!sid) return remoteAddr;
        return transportRemoteAddrs.get(sid) ?? remoteAddr;
      },
      resolveSessionPrincipal: (sid) => (sid ? transportPrincipals.get(sid) : undefined),
      resolveSessionWorkspaceAllowlist: (sid) => (sid ? transportWorkspaceAllowlists.get(sid) : undefined),
    });

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: options.stateful ? () => randomUUID() : undefined,
      ...(options.stateful
        ? {
            onsessioninitialized: (sid: string) => {
              transports.set(sid, transport);
              if (requestTier) {
                transportTiers.set(sid, requestTier);
              }
              transportRemoteAddrs.set(sid, remoteAddr);
              if (principal) transportPrincipals.set(sid, principal);
              if (workspaceAllowlist !== undefined) transportWorkspaceAllowlists.set(sid, workspaceAllowlist);
            },
          }
        : {}),
      enableJsonResponse: true,
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        transportTiers.delete(transport.sessionId);
        transportRemoteAddrs.delete(transport.sessionId);
        transportPrincipals.delete(transport.sessionId);
        transportWorkspaceAllowlists.delete(transport.sessionId);
        clearMcpSessionWorkspace(transport.sessionId);
      }
    };

    await mcpServer.connect(transport);
    return transport;
  }

  async function handlePost(req: Request, res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const remoteAddr = req.ip || req.socket.remoteAddress || 'unknown';
    const requestTier = (req as Request & { mcpTier?: McpTier }).mcpTier;
    const requestPrincipal = (req as Request & { mcpPrincipal?: string }).mcpPrincipal;
    const requestWorkspaceAllowlist = (req as Request & { mcpWorkspaceAllowlist?: string[] }).mcpWorkspaceAllowlist;
    let transport: StreamableHTTPServerTransport;
    let ephemeral = false;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
      transportRemoteAddrs.set(sessionId, remoteAddr);
      if (requestPrincipal) transportPrincipals.set(sessionId, requestPrincipal);
      if (requestWorkspaceAllowlist !== undefined) transportWorkspaceAllowlists.set(sessionId, requestWorkspaceAllowlist);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = await createTransport(remoteAddr, requestTier, { stateful: true }, requestPrincipal, requestWorkspaceAllowlist);
    } else if (!sessionId || (sessionId && !transports.has(sessionId) && !isInitializeRequest(req.body))) {
      // Compatibility mode for one-shot callers that invoke /mcp directly without
      // first persisting an MCP session, or that present a stale session id after
      // a backend restart. Proper MCP clients should still initialize and reuse the
      // returned mcp-session-id, but stateless POSTs for tools/list and tools/call
      // can be served safely through a per-request transport.
      transport = await createTransport(remoteAddr, requestTier, { stateful: false }, requestPrincipal, requestWorkspaceAllowlist);
      ephemeral = true;
    } else {
      res.status(400).json({ error: 'Missing or invalid mcp-session-id header' });
      return;
    }


    try {
      await transport.handleRequest(req, res, req.body);
    } finally {
      if (ephemeral) {
        await transport.close().catch(() => {});
      }
    }
  }

  async function handleGet(req: Request, res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Missing or invalid mcp-session-id header' });
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
  }
  async function handleDelete(req: Request, res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Missing or invalid mcp-session-id header' });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
    transportTiers.delete(sessionId);
    transportRemoteAddrs.delete(sessionId);
    transportPrincipals.delete(sessionId);
    transportWorkspaceAllowlists.delete(sessionId);
    clearMcpSessionWorkspace(sessionId);
  }

  return { handlePost, handleGet, handleDelete };
}
