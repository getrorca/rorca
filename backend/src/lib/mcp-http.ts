/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
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
  items?: { type?: string };
  minimum?: number;
  maximum?: number;
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

interface McpHttpServerOptions {
  resolveSessionTier?: (sessionId: string | undefined) => McpTier | undefined;
  getSessionRemoteAddr?: (sessionId: string | undefined) => string | undefined;
}

function getMcpExposureOverride(operation: OpenAPIOperation): McpTier | null {
  const raw = operation['x-mcp-tier'];
  if (raw === 'public' || raw === 'admin') {
    return raw;
  }
  return null;
}

const PUBLIC_TOOL_RULES: Array<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/api\/specs(?:\/[^/]+(?:\/versions(?:\/[^/]+\/diff)?)?)?$/ },
  { method: 'GET', pattern: /^\/api\/specs\/archive$/ },
  { method: 'GET', pattern: /^\/api\/specs\/kanban$/ },
  { method: 'GET', pattern: /^\/api\/specs\/[^/]+\/graph$/ },
  { method: 'GET', pattern: /^\/api\/pipeline\/runs(?:\/[^/]+)?$/ },
  { method: 'GET', pattern: /^\/api\/pipeline\/worker\/health$/ },
  { method: 'GET', pattern: /^\/api\/analytics$/ },
  { method: 'GET', pattern: /^\/api\/activity$/ },
  { method: 'GET', pattern: /^\/api\/wal$/ },
  { method: 'GET', pattern: /^\/api\/skills(?:\/top|\/suggestions|\/[^/]+\/content)?$/ },
  { method: 'GET', pattern: /^\/api\/templates$/ },
  { method: 'GET', pattern: /^\/api\/graph\/stats$/ },
  { method: 'POST', pattern: /^\/api\/direction\/synthesize$/ },
  { method: 'POST', pattern: /^\/api\/pipeline\/runs\/external$/ },
  { method: 'POST', pattern: /^\/api\/pipeline\/runs\/[^/]+\/heartbeat$/ },
  { method: 'POST', pattern: /^\/api\/pipeline\/runs\/[^/]+\/finalize$/ },
  { method: 'POST', pattern: /^\/api\/pipeline\/runs\/[^/]+\/cancel$/ },
];

function isPublicTool(definition: Pick<McpToolDefinition, 'capturedMethod' | 'capturedPath'>): boolean {
  return PUBLIC_TOOL_RULES.some((rule) =>
    rule.method === definition.capturedMethod && rule.pattern.test(definition.capturedPath));
}

export function getMcpToolTier(definition: Pick<McpToolDefinition, 'capturedMethod' | 'capturedPath'>): McpTier {
  return isPublicTool(definition) ? 'public' : 'admin';
}

export function buildMcpToolTierResolver(spec: OpenAPISpec): (toolName: string) => McpTier {
  const definitions = getMcpToolDefinitions(spec);
  const toolTierMap = new Map(definitions.map((definition) => [definition.toolName, getMcpToolTier(definition)]));
  return (toolName: string) => toolTierMap.get(toolName) ?? 'admin';
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

  switch (prop.type) {
    case 'integer':
    case 'number': {
      let numSchema = z.number();
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
    case 'array': {
      const itemType = prop.items?.type === 'number' || prop.items?.type === 'integer'
        ? z.number()
        : z.string();
      let arrSchema = z.array(itemType);
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

function buildZodInputShape(
  operation: OpenAPIOperation,
): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  const requiredBodyFields = new Set<string>();

  // Collect required body fields
  const jsonContent = operation.requestBody?.content?.['application/json'];
  if (jsonContent?.schema?.required) {
    for (const r of jsonContent.schema.required) {
      requiredBodyFields.add(r);
    }
  }

  // Path and query parameters
  if (operation.parameters) {
    for (const param of operation.parameters) {
      if (param.in === 'header' || param.in === 'cookie') continue;

      const propSchema: OpenAPIPropertySchema = {
        type: param.schema?.type || 'string',
        description: param.description || param.schema?.description,
        enum: param.schema?.enum,
        items: param.schema?.items,
      };

      // workspaceId is auto-injected by executeApiCall when missing — mark optional
      // in MCP schema so the SDK doesn't reject calls without it.
      const isRequired = param.name === 'workspaceId' ? false : param.required === true;
      shape[param.name] = openApiTypeToZod(propSchema, isRequired);
    }
  }

  // Request body properties
  if (jsonContent?.schema?.properties) {
    for (const [propName, propSchema] of Object.entries(jsonContent.schema.properties)) {
      shape[propName] = openApiTypeToZod(propSchema, requiredBodyFields.has(propName));
    }
  }

  // multipart/form-data
  const formContent = operation.requestBody?.content?.['multipart/form-data'];
  if (formContent?.schema?.properties) {
    for (const [propName, propSchema] of Object.entries(formContent.schema.properties)) {
      shape[propName] = openApiTypeToZod(propSchema, false);
    }
  }

  return shape;
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
  return {
    status: job.status === 'cancelled' ? 409 : 500,
    body: {
      error: message,
      code: job.status === 'cancelled' ? 'SPEC_JOB_CANCELLED' : 'SPEC_JOB_FAILED',
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
): Promise<{ status: number; body: unknown }> {
  // Auto-inject workspaceId when required but not provided — makes MCP tools
  // "just work" without forcing users to know/specify the workspace ID.
  const requiredParams = (operation?.parameters || []).filter(p => p.required);
  for (const rp of requiredParams) {
    if (rp.name === 'workspaceId' && !params.workspaceId) {
      const defaultId = await getDefaultWorkspaceId();
      if (defaultId) params.workspaceId = defaultId;
    }
  }

  let resolvedPath = pathTemplate;
  const queryParams: Record<string, string> = {};
  const bodyParams: Record<string, unknown> = {};
  const pathParamNames = extractPathParams(pathTemplate);

  for (const [key, value] of Object.entries(params)) {
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

  const fetchOptions: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
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
        const { status, body } = await executeApiCall(capturedMethod, capturedPath, params, capturedOperation);
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

  const definitionByPath = new Map(definitions.map((definition) => [definition.capturedPath, definition]));
  const legacyAliases = [
    {
      toolName: 'rorca_enrich_spec',
      description: 'Legacy alias for spec enrichment via the async spec-job bridge.',
      path: '/api/specs/{specId}/enrich',
    },
    {
      toolName: 'rorca_match_skills',
      description: 'Legacy alias for spec skill matching via the async spec-job bridge.',
      path: '/api/specs/{specId}/match-skills',
    },
    {
      toolName: 'rorca_suggest_skills',
      description: 'Legacy alias for spec skill suggestions via the async spec-job bridge.',
      path: '/api/specs/{specId}/suggest-skills',
    },
  ] as const;

  let aliasCount = 0;
  for (const alias of legacyAliases) {
    const definition = definitionByPath.get(alias.path);
    if (definition) {
      registerDefinition(definition, {
        toolName: alias.toolName,
        description: alias.description,
      });
      aliasCount += 1;
    }
  }

  logger.info(`[MCP-HTTP] Registered ${definitions.length} OpenAPI tools and ${aliasCount} legacy aliases`);
  return server;
}

// ─── Transport session management ───────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();
const transportTiers = new Map<string, McpTier>();
const transportRemoteAddrs = new Map<string, string>();

export function getMcpTransportCount(): number {
  return transports.size;
}

/**
 * Create Express-compatible request handlers for MCP HTTP at /mcp.
 * Supports POST (client→server), GET (SSE notifications), DELETE (session close).
 */
export function createMcpRequestHandler(spec: OpenAPISpec) {
  async function handlePost(req: Request, res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const remoteAddr = req.ip || req.socket.remoteAddress || 'unknown';
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
      transportRemoteAddrs.set(sessionId, remoteAddr);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const requestTier = (req as Request & { mcpTier?: McpTier }).mcpTier;
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
      });

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport);
          if (requestTier) {
            transportTiers.set(sid, requestTier);
          }
          transportRemoteAddrs.set(sid, remoteAddr);
        },
        enableJsonResponse: true,
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
          transportTiers.delete(transport.sessionId);
          transportRemoteAddrs.delete(transport.sessionId);
        }
      };

      await mcpServer.connect(transport);
    } else {
      res.status(400).json({ error: 'Missing or invalid mcp-session-id header' });
      return;
    }

    await transport.handleRequest(req, res, req.body);
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
  }

  return { handlePost, handleGet, handleDelete };
}
