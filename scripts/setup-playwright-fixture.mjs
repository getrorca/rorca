/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath } from 'node:fs/promises';

const apiUrl = new URL(process.env.PLAYWRIGHT_API_BASE_URL ?? 'http://127.0.0.1:3030');
if (!['127.0.0.1', 'localhost', '::1'].includes(apiUrl.hostname)) {
  throw new Error(`Playwright fixture provisioning refuses non-local API host: ${apiUrl.hostname}`);
}
if (process.env.CI !== 'true') {
  throw new Error('Playwright fixture provisioning is CI-only; use an explicitly prepared local stack for npm run test:e2e');
}

const workspaceId = 'rorca-ci-e2e';
const workspacePath = await realpath(process.env.RORCA_E2E_WORKSPACE_PATH ?? process.cwd());
const origin = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5210';
const csrfResponse = await fetch(new URL('/api/auth/csrf-token', apiUrl), {
  headers: { origin },
});
if (!csrfResponse.ok) {
  throw new Error(`Could not obtain E2E CSRF authority (${csrfResponse.status}): ${await csrfResponse.text()}`);
}
const csrfBody = await csrfResponse.json();
const csrfToken = typeof csrfBody?.token === 'string' ? csrfBody.token : '';
if (!/^[0-9a-f]{64}$/.test(csrfToken)) {
  throw new Error('E2E CSRF authority returned an invalid token');
}
const headers = {
  'content-type': 'application/json',
  origin,
  cookie: `_csrf=${csrfToken}`,
  'x-csrf-token': csrfToken,
  'x-rorca-operator-authority': 'local-ci-e2e',
};

const create = await fetch(new URL('/api/workspaces', apiUrl), {
  method: 'POST',
  headers,
  body: JSON.stringify({
    id: workspaceId,
    label: 'Rorca CI E2E',
    path: workspacePath,
    domains: ['frontend', 'backend'],
  }),
});
if (!create.ok && create.status !== 409) {
  throw new Error(`Could not provision E2E workspace (${create.status}): ${await create.text()}`);
}

const workspaces = await fetch(new URL('/api/workspaces', apiUrl), { headers });
if (!workspaces.ok) {
  throw new Error(`Could not verify E2E workspace (${workspaces.status}): ${await workspaces.text()}`);
}
const workspaceBody = await workspaces.json();
const workspaceItems = Array.isArray(workspaceBody)
  ? workspaceBody
  : (workspaceBody.workspaces ?? workspaceBody.items ?? []);
if (!workspaceItems.some((workspace) => workspace.id === workspaceId)) {
  throw new Error(`Provisioned E2E workspace ${workspaceId} is absent from the API projection`);
}

const specs = await fetch(new URL(`/api/specs?workspaceId=${encodeURIComponent(workspaceId)}&status=all`, apiUrl), { headers });
if (!specs.ok) {
  throw new Error(`Could not verify E2E specs (${specs.status}): ${await specs.text()}`);
}
const specsBody = await specs.json();
const specItems = Array.isArray(specsBody) ? specsBody : (specsBody.specs ?? specsBody.items ?? []);
if (specItems.length === 0) {
  throw new Error(`E2E workspace ${workspaceId} exposes no specs; mandatory attachment tests cannot run`);
}

process.stdout.write(`Provisioned ${workspaceId} with ${specItems.length} discoverable spec(s)\n`);
