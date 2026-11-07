/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors';

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/)
  .transform((value): `sha256:${string}` => value as `sha256:${string}`);
const exactOrigin = z.string().url().transform((value, context) => {
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((!loopback && url.protocol !== 'https:')
    || (loopback && url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    context.addIssue({ code: 'custom', message: 'Fixture origin must be an exact HTTPS or loopback HTTP origin' });
    return z.NEVER;
  }
  return url.origin;
});
const redirectUri = z.string().url().transform((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    context.addIssue({ code: 'custom', message: 'OAuth redirect URI must be HTTPS without credentials or fragment' });
    return z.NEVER;
  }
  return url.href;
});

export type BrowserMcpConformanceConsumer = 'claude' | 'chatgpt';
export const CLAUDE_CONFORMANCE_CLIENT_ID = 'rorca-claude-conformance-v1' as const;
export const CHATGPT_CONFORMANCE_CLIENT_ID = 'rorca-chatgpt-conformance-v1' as const;
const ACCESS_TOKEN_TTL_SECONDS = 10;
export const BROWSER_MCP_CONFORMANCE_SCOPE = 'mcp:tools' as const;
export const BROWSER_MCP_CONFORMANCE_TOOL_NAME = 'rorca_conformance_echo' as const;
export const BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS = Object.freeze({
  claude: 'BSB-004',
  chatgpt: 'BSB-005',
} as const);

const ConsumerFixtureSchema = z.discriminatedUnion('consumerProvider', [
  z.object({
    consumerProvider: z.literal('claude'),
    publicOrigin: exactOrigin,
    subject: z.string().trim().toLowerCase().regex(/^claude-[a-z0-9][a-z0-9._-]{2,100}$/),
    clientId: z.literal(CLAUDE_CONFORMANCE_CLIENT_ID),
    redirectUris: z.array(redirectUri).min(1).max(4)
      .refine((values) => new Set(values).size === values.length, 'Redirect URIs must be unique'),
    expiresAt: z.string().datetime(),
  }).strict(),
  z.object({
    consumerProvider: z.literal('chatgpt'),
    publicOrigin: exactOrigin,
    subject: z.string().trim().toLowerCase().regex(/^chatgpt-[a-z0-9][a-z0-9._-]{2,100}$/),
    clientId: z.literal(CHATGPT_CONFORMANCE_CLIENT_ID),
    redirectUris: z.array(redirectUri).min(1).max(4)
      .refine((values) => new Set(values).size === values.length, 'Redirect URIs must be unique'),
    expiresAt: z.string().datetime(),
  }).strict(),
]);
export const CreateBrowserMcpConformanceFixtureSchema = ConsumerFixtureSchema;
export type CreateBrowserMcpConformanceFixture = z.infer<typeof CreateBrowserMcpConformanceFixtureSchema>;

export type BrowserMcpConformanceEventType =
  | 'fixture_created'
  | 'client_registered'
  | 'authorization_requested'
  | 'consent_approved'
  | 'oauth_token_issued'
  | 'oauth_token_refreshed'
  | 'mcp_initialized'
  | 'mcp_tool_listed'
  | 'mcp_tool_called'
  | 'oauth_revoked'
  | 'post_revocation_denied';

export interface BrowserMcpConformanceEvent {
  sequence: number;
  type: BrowserMcpConformanceEventType;
  observedAt: string;
  resultHash?: `sha256:${string}`;
}

export interface BrowserMcpConformanceFixtureSnapshot {
  schemaVersion: 'rorca.browser-mcp-conformance-fixture.v1';
  fixtureId: string;
  consumerProvider: BrowserMcpConformanceConsumer;
  publicOrigin: string;
  fixtureOrigin: string;
  subject: string;
  clientId: typeof CLAUDE_CONFORMANCE_CLIENT_ID | typeof CHATGPT_CONFORMANCE_CLIENT_ID;
  scope: typeof BROWSER_MCP_CONFORMANCE_SCOPE;
  tool: {
    name: typeof BROWSER_MCP_CONFORMANCE_TOOL_NAME;
    inputContract: {
      type: 'object';
      value: { const: (typeof BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS)[BrowserMcpConformanceConsumer] };
    };
    resultHash: `sha256:${string}`;
  };
  expiresAt: string;
  oauthState: 'awaiting_consent' | 'active' | 'revoked' | 'expired';
  events: BrowserMcpConformanceEvent[];
}

interface AuthorizationRequest {
  id: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  consumed: boolean;
}

interface AuthorizationCode {
  digest: string;
  redirectUri: string;
  codeChallenge: string;
  consumed: boolean;
  expiresAt: number;
}

interface OAuthGrant {
  accessDigest: string;
  refreshDigest: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  revoked: boolean;
}

interface FixtureState {
  fixtureId: string;
  input: CreateBrowserMcpConformanceFixture;
  fixtureOrigin: string;
  authorizationRequests: Map<string, AuthorizationRequest>;
  authorizationCodes: Map<string, AuthorizationCode>;
  grants: OAuthGrant[];
  events: BrowserMcpConformanceEvent[];
}

export type OAuthTokenResult =
  | { ok: true; accessToken: string; refreshToken?: string; expiresIn: number }
  | { ok: false; status: 400 | 401; error: 'invalid_client' | 'invalid_grant' | 'invalid_request' };

export type McpProtocolResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 202; body: null }
  | { status: 400 | 401 | 403; body: Record<string, unknown> };

const EXPECTED_EVENTS: readonly BrowserMcpConformanceEventType[] = [
  'fixture_created',
  'client_registered',
  'authorization_requested',
  'consent_approved',
  'oauth_token_issued',
  'mcp_initialized',
  'mcp_tool_listed',
  'mcp_tool_called',
  'oauth_token_refreshed',
  'oauth_revoked',
  'post_revocation_denied',
];

function digest(value: crypto.BinaryLike): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function token(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function basePath(fixtureId: string): string {
  return `/browser-conformance/${fixtureId}`;
}

export class BrowserMcpConformanceFixtureRegistry {
  private readonly fixtures = new Map<string, FixtureState>();

  constructor(
    private readonly enabled: () => boolean = () => {
      const value = process.env.RORCA_BROWSER_MCP_CONFORMANCE_ENABLED?.trim().toLowerCase();
      return value === 'true' || value === '1';
    },
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(input: CreateBrowserMcpConformanceFixture): BrowserMcpConformanceFixtureSnapshot {
    this.assertEnabled();
    const parsed = CreateBrowserMcpConformanceFixtureSchema.parse(input);
    const now = Date.parse(this.now());
    const expiresAt = Date.parse(parsed.expiresAt);
    if (expiresAt <= now || expiresAt > now + 30 * 60_000) {
      throw new ValidationError('Conformance fixture expiry must be within the next 30 minutes');
    }
    const fixtureId = crypto.randomUUID();
    const fixtureOrigin = `${parsed.publicOrigin}${basePath(fixtureId)}`;
    const state: FixtureState = {
      fixtureId,
      input: parsed,
      fixtureOrigin,
      authorizationRequests: new Map(),
      authorizationCodes: new Map(),
      grants: [],
      events: [],
    };
    this.fixtures.set(fixtureId, state);
    this.record(state, 'fixture_created');
    return this.snapshot(state);
  }

  destroy(fixtureId: string): void {
    const state = this.require(fixtureId);
    for (const grant of state.grants) grant.revoked = true;
    state.authorizationCodes.clear();
    state.authorizationRequests.clear();
    this.fixtures.delete(state.fixtureId);
  }

  metadata(fixtureId: string): {
    protectedResource: Record<string, unknown>;
    authorizationServer: Record<string, unknown>;
  } {
    const state = this.requireActive(fixtureId);
    return {
      protectedResource: {
        resource: `${state.fixtureOrigin}/mcp`,
        authorization_servers: [state.fixtureOrigin],
        scopes_supported: [BROWSER_MCP_CONFORMANCE_SCOPE],
      },
      authorizationServer: {
        issuer: state.fixtureOrigin,
        authorization_endpoint: `${state.fixtureOrigin}/oauth/authorize`,
        token_endpoint: `${state.fixtureOrigin}/oauth/token`,
        registration_endpoint: `${state.fixtureOrigin}/oauth/register`,
        revocation_endpoint: `${state.fixtureOrigin}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: [BROWSER_MCP_CONFORMANCE_SCOPE],
        token_endpoint_auth_methods_supported: ['none'],
      },
    };
  }

  registerClient(fixtureId: string, input: Record<string, unknown>): Record<string, unknown> {
    const state = this.requireActive(fixtureId);
    const clientName = state.input.consumerProvider === 'claude'
      ? /^Claude(?: Web)?$/
      : /^ChatGPT(?: Web)?$/;
    const parsed = z.object({
      client_name: z.string().trim().regex(clientName),
      redirect_uris: z.array(redirectUri).length(state.input.redirectUris.length),
      token_endpoint_auth_method: z.literal('none'),
      grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).length(2),
      response_types: z.array(z.literal('code')).length(1),
      application_type: z.literal('web').optional(),
    }).strict().safeParse(input);
    if (!parsed.success
      || !parsed.data.redirect_uris.every((uri) => state.input.redirectUris.includes(uri))
      || !parsed.data.grant_types.includes('authorization_code')
      || !parsed.data.grant_types.includes('refresh_token')) {
      throw new ForbiddenError(`OAuth client registration does not match the bounded ${state.input.consumerProvider} fixture client`);
    }
    this.recordOnce(state, 'client_registered');
    return {
      client_id: state.input.clientId,
      client_id_issued_at: Math.floor(Date.parse(this.now()) / 1_000),
      client_name: parsed.data.client_name,
      redirect_uris: [...state.input.redirectUris],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  beginAuthorization(fixtureId: string, query: Record<string, unknown>): { requestId: string; html: string } {
    const state = this.requireActive(fixtureId);
    const parsed = z.object({
      client_id: z.string(),
      redirect_uri: redirectUri,
      response_type: z.literal('code'),
      scope: z.literal(BROWSER_MCP_CONFORMANCE_SCOPE),
      state: z.string().min(16).max(512),
      code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
      code_challenge_method: z.literal('S256'),
      resource: z.string().url().optional(),
    }).strict().safeParse(query);
    if (!parsed.success
      || parsed.data.client_id !== state.input.clientId
      || !state.input.redirectUris.includes(parsed.data.redirect_uri)
      || (parsed.data.resource !== undefined && parsed.data.resource !== `${state.fixtureOrigin}/mcp`)) {
      throw new ForbiddenError(`OAuth authorization request does not match the bounded ${state.input.consumerProvider} fixture client`);
    }
    const requestId = crypto.randomUUID();
    state.authorizationRequests.set(requestId, {
      id: requestId,
      redirectUri: parsed.data.redirect_uri,
      state: parsed.data.state,
      codeChallenge: parsed.data.code_challenge,
      consumed: false,
    });
    this.record(state, 'authorization_requested');
    return {
      requestId,
      html: this.consentHtml(state, requestId),
    };
  }

  approveConsent(fixtureId: string, requestId: string): string {
    const state = this.requireActive(fixtureId);
    const request = state.authorizationRequests.get(z.string().uuid().parse(requestId));
    if (!request || request.consumed) throw new ConflictError('OAuth consent request is absent or already consumed');
    request.consumed = true;
    const authorizationCode = token();
    state.authorizationCodes.set(digest(authorizationCode), {
      digest: digest(authorizationCode),
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      consumed: false,
      expiresAt: Date.parse(this.now()) + 60_000,
    });
    this.record(state, 'consent_approved');
    const target = new URL(request.redirectUri);
    target.searchParams.set('code', authorizationCode);
    target.searchParams.set('state', request.state);
    return target.href;
  }

  exchangeToken(fixtureId: string, body: Record<string, unknown>): OAuthTokenResult {
    const state = this.requireActive(fixtureId);
    if (body.client_id !== state.input.clientId) {
      return { ok: false, status: 401, error: 'invalid_client' };
    }
    if (body.grant_type === 'authorization_code') {
      const parsed = z.object({
        grant_type: z.literal('authorization_code'),
        client_id: z.string(),
        code: z.string().min(1).max(512),
        redirect_uri: redirectUri,
        code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
        resource: z.string().url().optional(),
      }).strict().safeParse(body);
      if (!parsed.success
        || parsed.data.client_id !== state.input.clientId
        || (parsed.data.resource !== undefined && parsed.data.resource !== `${state.fixtureOrigin}/mcp`)) {
        return { ok: false, status: 400, error: 'invalid_request' };
      }
      const code = state.authorizationCodes.get(digest(parsed.data.code));
      const challenge = crypto.createHash('sha256').update(parsed.data.code_verifier).digest('base64url');
      if (!code || code.consumed || code.expiresAt <= Date.parse(this.now())
        || code.redirectUri !== parsed.data.redirect_uri || !safeEqual(code.codeChallenge, challenge)) {
        return { ok: false, status: 400, error: 'invalid_grant' };
      }
      code.consumed = true;
      const grant = this.issueGrant();
      state.grants.push(grant.record);
      this.record(state, 'oauth_token_issued');
      return {
        ok: true,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      };
    }
    if (body.grant_type === 'refresh_token') {
      const parsed = z.object({
        grant_type: z.literal('refresh_token'),
        client_id: z.string(),
        refresh_token: z.string().min(1).max(512),
        scope: z.literal(BROWSER_MCP_CONFORMANCE_SCOPE).optional(),
        resource: z.string().url().optional(),
      }).strict().safeParse(body);
      if (!parsed.success
        || parsed.data.client_id !== state.input.clientId
        || (parsed.data.resource !== undefined && parsed.data.resource !== `${state.fixtureOrigin}/mcp`)) {
        return { ok: false, status: 400, error: 'invalid_request' };
      }
      const existing = state.grants.find((grant) => safeEqual(grant.refreshDigest, digest(parsed.data.refresh_token)));
      if (!existing || existing.revoked || existing.refreshExpiresAt <= Date.parse(this.now())) {
        return { ok: false, status: 400, error: 'invalid_grant' };
      }
      existing.revoked = true;
      const grant = this.issueGrant();
      state.grants.push(grant.record);
      this.record(state, 'oauth_token_refreshed');
      return {
        ok: true,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      };
    }
    return { ok: false, status: 400, error: 'invalid_request' };
  }

  revoke(fixtureId: string, body: Record<string, unknown>): { revoked: boolean } {
    const state = this.require(fixtureId);
    const parsed = z.object({
      client_id: z.string(),
      token: z.string().min(1).max(512),
      token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
    }).strict().safeParse(body);
    if (!parsed.success || parsed.data.client_id !== state.input.clientId) {
      throw new ForbiddenError(`OAuth revocation request does not match the bounded ${state.input.consumerProvider} fixture client`);
    }
    const tokenDigest = digest(parsed.data.token);
    const grant = state.grants.find((candidate) => safeEqual(candidate.accessDigest, tokenDigest)
      || safeEqual(candidate.refreshDigest, tokenDigest));
    if (!grant) return { revoked: false };
    for (const candidate of state.grants) candidate.revoked = true;
    this.record(state, 'oauth_revoked');
    return { revoked: true };
  }

  handleMcp(fixtureId: string, authorization: string | undefined, payload: unknown): McpProtocolResult {
    const state = this.require(fixtureId);
    const tokenValue = authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,512})$/)?.[1];
    const active = tokenValue
      ? state.grants.find((grant) => safeEqual(grant.accessDigest, digest(tokenValue)))
      : undefined;
    if (!active || active.revoked || active.accessExpiresAt <= Date.parse(this.now())) {
      if (state.events.some((event) => event.type === 'oauth_revoked')) {
        this.recordOnce(state, 'post_revocation_denied');
      }
      return { status: 401, body: { error: 'invalid_token' } };
    }
    const request = z.object({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.string(), z.number()]).optional(),
      method: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    }).strict().safeParse(payload);
    if (!request.success) return { status: 400, body: { error: 'invalid_request' } };
    const id = request.data.id ?? null;
    if (request.data.method === 'notifications/initialized') return { status: 202, body: null };
    if (request.data.method === 'initialize') {
      this.recordOnce(state, 'mcp_initialized');
      return { status: 200, body: {
        jsonrpc: '2.0', id, result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'rorca-mcp-conformance', version: '1.0.0' },
        },
      } };
    }
    if (request.data.method === 'tools/list') {
      this.recordOnce(state, 'mcp_tool_listed');
      const toolArgument = BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS[state.input.consumerProvider];
      return { status: 200, body: {
        jsonrpc: '2.0', id, result: { tools: [{
          name: BROWSER_MCP_CONFORMANCE_TOOL_NAME,
          description: 'Returns one fixed harmless Rorca conformance value.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string', const: toolArgument } },
            required: ['value'],
            additionalProperties: false,
          },
        }] },
      } };
    }
    if (request.data.method === 'tools/call') {
      const call = z.object({
        name: z.literal(BROWSER_MCP_CONFORMANCE_TOOL_NAME),
        arguments: z.object({ value: z.string() }).strict(),
      }).strict().safeParse(request.data.params);
      const toolArgument = BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS[state.input.consumerProvider];
      if (!call.success || call.data.arguments.value !== toolArgument) {
        return { status: 403, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Bounded tool contract denied' } } };
      }
      const resultText = JSON.stringify({ fixture: 'rorca', story: toolArgument, value: toolArgument });
      this.recordOnce(state, 'mcp_tool_called', digest(resultText));
      return { status: 200, body: {
        jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: resultText }], isError: false },
      } };
    }
    return { status: 403, body: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not admitted' } } };
  }

  snapshotById(fixtureId: string): BrowserMcpConformanceFixtureSnapshot {
    return this.snapshot(this.require(fixtureId));
  }

  assertComplete(fixtureId: string): BrowserMcpConformanceFixtureSnapshot {
    const state = this.require(fixtureId);
    const observed = state.events.map((event) => event.type);
    let cursor = -1;
    for (const expected of EXPECTED_EVENTS) {
      cursor = observed.indexOf(expected, cursor + 1);
      if (cursor === -1) throw new ConflictError('Browser MCP conformance fixture journey is incomplete', { expected });
    }
    const snapshot = this.snapshot(state);
    if (snapshot.oauthState !== 'revoked') {
      throw new ConflictError('Browser MCP conformance OAuth grant is not revoked');
    }
    return snapshot;
  }

  private issueGrant(): { accessToken: string; refreshToken: string; record: OAuthGrant } {
    const accessToken = token();
    const refreshToken = token();
    const now = Date.parse(this.now());
    return {
      accessToken,
      refreshToken,
      record: {
        accessDigest: digest(accessToken),
        refreshDigest: digest(refreshToken),
        accessExpiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1_000,
        refreshExpiresAt: now + 10 * 60_000,
        revoked: false,
      },
    };
  }

  private snapshot(state: FixtureState): BrowserMcpConformanceFixtureSnapshot {
    const now = Date.parse(this.now());
    const latestGrant = state.grants.at(-1);
    const oauthState = Date.parse(state.input.expiresAt) <= now
      ? 'expired'
      : latestGrant?.revoked
        ? 'revoked'
        : latestGrant
          ? 'active'
          : 'awaiting_consent';
    const toolArgument = BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS[state.input.consumerProvider];
    const resultHash = digest(JSON.stringify({ fixture: 'rorca', story: toolArgument, value: toolArgument }));
    return {
      schemaVersion: 'rorca.browser-mcp-conformance-fixture.v1',
      fixtureId: state.fixtureId,
      consumerProvider: state.input.consumerProvider,
      publicOrigin: state.input.publicOrigin,
      fixtureOrigin: state.fixtureOrigin,
      subject: state.input.subject,
      clientId: state.input.clientId,
      scope: BROWSER_MCP_CONFORMANCE_SCOPE,
      tool: {
        name: BROWSER_MCP_CONFORMANCE_TOOL_NAME,
        inputContract: { type: 'object', value: { const: toolArgument } },
        resultHash: sha256.parse(resultHash),
      },
      expiresAt: state.input.expiresAt,
      oauthState,
      events: state.events.map((event) => ({ ...event })),
    };
  }

  private consentHtml(state: FixtureState, requestId: string): string {
    const approvePath = `${basePath(state.fixtureId)}/oauth/consent/${requestId}/approve`;
    const toolArgument = BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS[state.input.consumerProvider];
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rorca MCP conformance consent</title></head><body data-rorca-auth-state="consent"><main><h1>Rorca MCP conformance fixture</h1><p>Identity: ${state.input.subject}</p><p>Client: ${state.input.clientId}</p><p>Scope: ${BROWSER_MCP_CONFORMANCE_SCOPE}</p><p>Tool: ${BROWSER_MCP_CONFORMANCE_TOOL_NAME} returns only ${toolArgument}.</p><a data-testid="rorca-conformance-consent" href="${approvePath}">Approve bounded test</a></main></body></html>`;
  }

  private require(fixtureId: string): FixtureState {
    const id = z.string().uuid().parse(fixtureId);
    const state = this.fixtures.get(id);
    if (!state) throw new NotFoundError('Browser MCP conformance fixture', id);
    return state;
  }

  private requireActive(fixtureId: string): FixtureState {
    this.assertEnabled();
    const state = this.require(fixtureId);
    if (Date.parse(state.input.expiresAt) <= Date.parse(this.now())) {
      for (const grant of state.grants) grant.revoked = true;
      throw new ConflictError('Browser MCP conformance fixture has expired');
    }
    return state;
  }

  private assertEnabled(): void {
    if (!this.enabled()) throw new ForbiddenError('Browser MCP conformance fixture is disabled');
  }

  private record(state: FixtureState, type: BrowserMcpConformanceEventType, resultHash?: `sha256:${string}`): void {
    state.events.push({
      sequence: state.events.length + 1,
      type,
      observedAt: this.now(),
      ...(resultHash ? { resultHash } : {}),
    });
  }

  private recordOnce(state: FixtureState, type: BrowserMcpConformanceEventType, resultHash?: `sha256:${string}`): void {
    if (!state.events.some((event) => event.type === type)) this.record(state, type, resultHash);
  }
}

export const browserMcpConformanceFixtureRegistry = new BrowserMcpConformanceFixtureRegistry();
