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
import { logger } from './logger';

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
  '/api/auth/github/callback',
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

  // Long-running endpoints (spec generation, enrichment, hydration, embedding, skills matching) need extended timeouts
  const SLOW_PATHS = ['/api/specs/generate', '/api/specs/generate-batch', '/api/workspaces/', '/api/admin/embed-all', '/enrich', '/match-skills', '/suggest-skills', '/add-stories', '/knowledge-graph'];
  const isSlowPath = SLOW_PATHS.some(p => resolvedPath.startsWith(p));
  const timeoutMs = isSlowPath ? 10 * 60 * 1000 : 30_000; // 10 min for slow (claude --print spec gen can take 5-8min), 30s default
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const fetchOptions: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
  };

  if (method !== 'GET' && method !== 'DELETE' && Object.keys(bodyParams).length > 0) {
    fetchOptions.body = JSON.stringify(bodyParams);
  }

  let fetchRes: Awaited<ReturnType<typeof fetch>>;
  try {
    fetchRes = await fetch(url, fetchOptions);
  } finally {
    clearTimeout(timeoutId);
  }
  const contentType = fetchRes.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await fetchRes.json()
    : await fetchRes.text();

  return { status: fetchRes.status, body };
}

// ─── Create MCP server with auto-generated tools ────────────────────────────

export function createMcpHttpServer(spec: OpenAPISpec): McpServer {
  const server = new McpServer({
    name: 'rorca-http',
    version: '2.0.0',
  });

  const allPaths = new Map<string, string[]>();
  for (const [pathStr, methods] of Object.entries(spec.paths)) {
    allPaths.set(pathStr, Object.keys(methods).map(m => m.toUpperCase()));
  }

  let toolCount = 0;

  for (const [pathStr, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const httpMethod = method.toUpperCase();

      if (shouldSkipRoute(httpMethod, pathStr)) continue;

      const toolName = generateToolName(httpMethod, pathStr, allPaths);
      const description = operation.summary || operation.description || `${httpMethod} ${pathStr}`;
      const zodShape = buildZodInputShape(operation);
      const hasParams = Object.keys(zodShape).length > 0;

      // Capture for closure
      const capturedMethod = httpMethod;
      const capturedPath = pathStr;

      // Capture operation for default-param injection
      const capturedOperation = operation;

      const handler = async (params: Record<string, unknown>) => {
        try {
          const { status, body } = await executeApiCall(capturedMethod, capturedPath, params, capturedOperation);

          if (status >= 400) {
            const errorText = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
            return {
              content: [{ type: 'text' as const, text: `Error (${status}): ${errorText}` }],
              isError: true,
            };
          }

          const resultText = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
          return {
            content: [{ type: 'text' as const, text: resultText }],
          };
        } catch (err: unknown) {
          const isAbort = err instanceof Error && err.name === 'AbortError';
          const message = isAbort
            ? `Tool timed out. This is a long-running operation — the backend is still processing. Check results via the relevant list/get tool after a moment.`
            : err instanceof Error ? err.message : String(err);
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

      toolCount++;
    }
  }

  logger.info(`[MCP-HTTP] Registered ${toolCount} tools from OpenAPI spec`);
  return server;
}

// ─── Transport session management ───────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

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
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const mcpServer = createMcpHttpServer(spec);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport);
        },
        enableJsonResponse: true,
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
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
  }

  return { handlePost, handleGet, handleDelete };
}
