/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  BROWSER_MCP_CONFORMANCE_SCOPE,
  BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS,
  BROWSER_MCP_CONFORMANCE_TOOL_NAME,
  CHATGPT_CONFORMANCE_CLIENT_ID,
  CLAUDE_CONFORMANCE_CLIENT_ID,
  BrowserMcpConformanceFixtureRegistry,
} from '../browser-mcp-conformance-fixture.js';

describe('Browser MCP conformance fixture', () => {
  it('completes Claude consent, code exchange, one harmless tool, refresh, revoke, and post-revocation denial', () => {
    let currentTime = Date.parse('2026-08-24T12:00:00.000Z');
    const registry = new BrowserMcpConformanceFixtureRegistry(
      () => true,
      () => new Date(currentTime).toISOString(),
    );
    const publicOrigin = 'http://127.0.0.1:3030';
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
    const fixture = registry.create({
      consumerProvider: 'claude',
      publicOrigin,
      subject: 'claude-dedicated-conformance',
      clientId: CLAUDE_CONFORMANCE_CLIENT_ID,
      redirectUris: [redirectUri],
      expiresAt: new Date(currentTime + 15 * 60_000).toISOString(),
    });

    const metadata = registry.metadata(fixture.fixtureId).authorizationServer;
    assert.equal(metadata.issuer, fixture.fixtureOrigin);
    assert.deepEqual(metadata.scopes_supported, [BROWSER_MCP_CONFORMANCE_SCOPE]);
    assert.deepEqual(registry.registerClient(fixture.fixtureId, {
      client_name: 'Claude',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
    }), {
      client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
      client_id_issued_at: Math.floor(currentTime / 1_000),
      client_name: 'Claude',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });

    const verifier = 'A'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorization = registry.beginAuthorization(fixture.fixtureId, {
      client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: BROWSER_MCP_CONFORMANCE_SCOPE,
      state: 'bounded-claude-state-0001',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    assert.match(authorization.html, /data-rorca-auth-state="consent"/);
    assert.match(authorization.html, /rorca_conformance_echo/);

    const callback = new URL(registry.approveConsent(fixture.fixtureId, authorization.requestId));
    const authorizationCode = callback.searchParams.get('code');
    assert.ok(authorizationCode);
    assert.equal(callback.searchParams.get('state'), 'bounded-claude-state-0001');

    const tokenResult = registry.exchangeToken(fixture.fixtureId, {
      grant_type: 'authorization_code',
      client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
      code: authorizationCode,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    assert.equal(tokenResult.ok, true);
    assert.ok(tokenResult.ok);
    const firstGrant = {
      accessToken: tokenResult.accessToken,
      refreshToken: tokenResult.refreshToken!,
    };

    const mcp = (accessToken: string, method: string, params?: Record<string, unknown>) => registry.handleMcp(
      fixture.fixtureId,
      `Bearer ${accessToken}`,
      { jsonrpc: '2.0', id: method, method, ...(params ? { params } : {}) },
    );
    assert.equal(mcp(firstGrant.accessToken, 'initialize').status, 200);
    const tools = mcp(firstGrant.accessToken, 'tools/list');
    assert.equal(tools.status, 200);
    assert.match(JSON.stringify(tools.body), new RegExp(BROWSER_MCP_CONFORMANCE_TOOL_NAME));
    const deniedTool = mcp(firstGrant.accessToken, 'tools/call', {
      name: BROWSER_MCP_CONFORMANCE_TOOL_NAME,
      arguments: { value: 'broadened' },
    });
    assert.equal(deniedTool.status, 403);
    const tool = mcp(firstGrant.accessToken, 'tools/call', {
      name: BROWSER_MCP_CONFORMANCE_TOOL_NAME,
      arguments: { value: BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS.claude },
    });
    assert.equal(tool.status, 200);
    assert.match(JSON.stringify(tool.body), /BSB-004/);

    currentTime += 11_000;
    const refreshResult = registry.exchangeToken(fixture.fixtureId, {
      grant_type: 'refresh_token',
      client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
      refresh_token: firstGrant.refreshToken,
    });
    assert.equal(refreshResult.ok, true);
    assert.ok(refreshResult.ok);
    const refreshedGrant = {
      accessToken: refreshResult.accessToken,
      refreshToken: refreshResult.refreshToken!,
    };

    registry.revoke(fixture.fixtureId, {
      client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
      token: refreshedGrant.refreshToken,
    });
    const deniedAfterRevoke = mcp(refreshedGrant.accessToken, 'tools/call', {
      name: BROWSER_MCP_CONFORMANCE_TOOL_NAME,
      arguments: { value: BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS.claude },
    });
    assert.equal(deniedAfterRevoke.status, 401);

    const completed = registry.assertComplete(fixture.fixtureId);
    assert.equal(completed.oauthState, 'revoked');
    assert.deepEqual(
      completed.events.map((event) => event.sequence),
      completed.events.map((_event, index) => index + 1),
    );
    const retainedEvidence = JSON.stringify(completed);
    for (const secret of [
      authorizationCode,
      verifier,
      firstGrant.accessToken,
      firstGrant.refreshToken,
      refreshedGrant.accessToken,
      refreshedGrant.refreshToken,
    ]) {
      assert.equal(retainedEvidence.includes(secret), false);
    }
    assert.doesNotMatch(retainedEvidence, /Categoric|Cashflow-App/i);
  });

  it('rejects any unbound subject, client, redirect, scope, PKCE mode, method, or tool input', () => {
    const now = Date.parse('2026-08-24T12:00:00.000Z');
    const registry = new BrowserMcpConformanceFixtureRegistry(() => true, () => new Date(now).toISOString());
    assert.throws(() => registry.create({
      consumerProvider: 'claude',
      publicOrigin: 'https://fixture.rorca.test',
      subject: 'personal-account',
      clientId: CLAUDE_CONFORMANCE_CLIENT_ID,
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      expiresAt: new Date(now + 60_000).toISOString(),
    }));
    const fixture = registry.create({
      consumerProvider: 'claude',
      publicOrigin: 'https://fixture.rorca.test',
      subject: 'claude-bounded-test',
      clientId: CLAUDE_CONFORMANCE_CLIENT_ID,
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    assert.throws(() => registry.registerClient(fixture.fixtureId, {
      client_name: 'Unbounded Client',
      redirect_uris: ['https://attacker.example/callback'],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['client_credentials'],
      response_types: ['token'],
    }));
    assert.throws(() => registry.beginAuthorization(fixture.fixtureId, {
      client_id: 'other-client',
      redirect_uri: 'https://attacker.example/callback',
      response_type: 'code',
      scope: 'mcp:tools admin',
      state: 'bounded-claude-state-0001',
      code_challenge: 'A'.repeat(43),
      code_challenge_method: 'plain',
    }));
    assert.deepEqual(registry.handleMcp(fixture.fixtureId, undefined, {
      jsonrpc: '2.0', id: 1, method: 'resources/read', params: {},
    }), { status: 401, body: { error: 'invalid_token' } });
  });

  it('binds ChatGPT fixtures to a distinct client, subject, OAuth grant, and deterministic input', () => {
    const now = Date.parse('2026-08-24T12:00:00.000Z');
    const registry = new BrowserMcpConformanceFixtureRegistry(() => true, () => new Date(now).toISOString());
    const chatgpt = registry.create({
      consumerProvider: 'chatgpt',
      publicOrigin: 'https://fixture.rorca.test',
      subject: 'chatgpt-dedicated-conformance',
      clientId: CHATGPT_CONFORMANCE_CLIENT_ID,
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      expiresAt: new Date(now + 60_000).toISOString(),
    });

    assert.equal(chatgpt.consumerProvider, 'chatgpt');
    assert.equal(chatgpt.tool.inputContract.value.const, 'BSB-005');
    assert.throws(() => registry.registerClient(chatgpt.fixtureId, {
      client_name: 'Claude',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
    }), /bounded chatgpt fixture client/);
    assert.throws(() => registry.beginAuthorization(chatgpt.fixtureId, {
      client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      response_type: 'code',
      scope: BROWSER_MCP_CONFORMANCE_SCOPE,
      state: 'bounded-chatgpt-state-0001',
      code_challenge: 'A'.repeat(43),
      code_challenge_method: 'S256',
    }), /bounded chatgpt fixture client/);
    assert.deepEqual(registry.exchangeToken(chatgpt.fixtureId, {
      grant_type: 'refresh_token',
      client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
      refresh_token: 'foreign-claude-oauth-grant',
    }), { ok: false, status: 401, error: 'invalid_client' });
  });
});
