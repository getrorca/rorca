/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

const route = fs.readFileSync(path.join(__dirname, '..', 'workspace-github-app.ts'), 'utf8');
const webhook = fs.readFileSync(path.join(__dirname, '..', 'webhooks.ts'), 'utf8');

test('setup/import/binding routes are admin-tier and read state is auth-tier', () => {
  expect(route).toMatch(/\/github\/app:\n \*   get:[\s\S]*?x-rorca-tier: auth/);
  for (const endpoint of ['setup/start', 'setup/exchange', 'import', 'revalidate', 'bind']) {
    const start = route.indexOf(`/github/app/${endpoint}:`);
    expect(start).toBeGreaterThan(0);
    expect(route.slice(start, start + 700)).toContain('x-rorca-tier: admin');
    expect(route.slice(start, start + 700)).toContain('x-rorca-rationale:');
  }
});

test('operator routes never return private key, webhook secret, JWT, or installation token', () => {
  const responseCalls = [...route.matchAll(/res\.json\((\{[\s\S]*?\})\);/g)].map((match) => match[1]).join('\n');
  expect(responseCalls).not.toMatch(/privateKeyPem\s*[:,]|webhookSecret\s*[:,]|\.token\s*[,}]/);
  expect(route).toContain("repository_ids: [repositoryId]");
  expect(route).toContain("repository_selection !== 'selected'");
});

test('GitHub webhook path enforces HMAC, exact App identity, event bounds, and atomic replay claim', () => {
  expect(webhook).toContain('MAX_GITHUB_WEBHOOK_BYTES');
  expect(webhook).toContain('SUPPORTED_GITHUB_EVENTS');
  expect(webhook).toContain('b.installation_id = $1 AND b.repository_id = $2');
  expect(webhook).toContain('verifyWebhookSignature(rawBody, signature, secret)');
  expect(webhook).toContain("claimDelivery('github', deliveryId");
  expect(webhook).not.toContain("dispatch('github', event, payload, meta);\n      await dispatchLegacyHandlers");
});
