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
const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.ts'), 'utf8');
const nginx = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'deploy', 'nginx.conf'), 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src', 'panels', 'GitHubSettingsPanel.tsx'), 'utf8');

test('setup/import/binding routes are admin-tier and read state is auth-tier', () => {
  expect(route).toMatch(/\/github\/app:\n \*   get:[\s\S]*?x-rorca-tier: auth/);
  for (const endpoint of ['setup/start', 'setup/exchange', 'import', 'revalidate', 'bind']) {
    const start = route.indexOf(`/github/app/${endpoint}:`);
    expect(start).toBeGreaterThan(0);
    expect(route.slice(start, start + 700)).toContain('x-rorca-tier: admin');
    expect(route.slice(start, start + 700)).toContain('x-rorca-rationale:');
  }
});

test('credential readiness, provider-hook configuration, and signed-delivery health remain separate', () => {
  expect(route).toContain('hook.active !== true');
  expect(route).toContain('providerHookConfigured: true');
  expect(route).toContain('signedDeliveryObserved: binding.signedDeliveryObserved');
  expect(route).toContain('signedDeliveryObserved: false');
  expect(route).not.toContain('webhookVerified: true');
  expect(route).not.toContain('webhook_verified = TRUE');
});

test('operator routes never return private key, webhook secret, JWT, or installation token', () => {
  const responseCalls = [...route.matchAll(/res\.json\((\{[\s\S]*?\})\);/g)].map((match) => match[1]).join('\n');
  expect(responseCalls).not.toMatch(/privateKeyPem\s*[:,]|webhookSecret\s*[:,]|\.token\s*[,}]/);
  expect(route).toContain("repository_ids: [repositoryId]");
  expect(route).toContain("repository_selection !== 'selected'");
  expect(route).toContain('insertPreparedIntegrationSecret(client, privateKey)');
  expect(route).toContain('insertPreparedIntegrationSecret(client, webhookSecret)');
});

test('Manifest callback survives reload, targets GitHub Settings, and is allowed by production CSP', () => {
  expect(route).toContain("new URL('/settings/github?github_app_setup=callback', appUrl)");
  expect(route).toContain('organizations/${encodeURIComponent(organization)}/settings/apps/new');
  expect(route).toContain('csrf_digest, requested_by, callback_url');
  expect(route).toContain('VALUES ($1, $2, $3, NULL, $4, $5, $6)');
  expect(server).toContain("formAction: [\"'self'\", 'https://github.com']");
  expect(nginx).toContain("form-action 'self' https://github.com");
  expect(nginx).not.toContain("form-action 'self'\"");
  expect(panel).toContain('Complete one-time App registration');
  expect(panel).toContain("window.history.replaceState({}, document.title, window.location.pathname + window.location.hash)");
});

test('GitHub webhook path enforces HMAC, exact App identity, event bounds, and atomic replay claim', () => {
  expect(webhook).toContain('MAX_GITHUB_WEBHOOK_BYTES');
  expect(webhook).toContain("'issues', 'check_run'");
  expect(webhook).toContain('b.installation_id = $1 AND b.repository_id = $2');
  expect(webhook.indexOf('const currentApp')).toBeLessThan(webhook.indexOf("'legacy-repository-webhook' AS source"));
  expect(webhook).toContain('GitHub App-bound repositories require installation');
  expect(webhook).toContain("authority_status = 'active' AND webhook_secret_revoked_at IS NULL");
  expect(route).toContain('webhook_secret_revoked_at = NOW()');
  expect(webhook).toContain('verifyWebhookSignature(rawBody, signature, secret)');
  expect(webhook).toContain("claimDelivery('github', deliveryId");
  expect(webhook).toContain("signed_delivery_observed = TRUE");
  expect(webhook).toContain("await webhookRouter.completeDelivery('github'");
  expect(webhook).toContain("await webhookRouter.failDelivery('github'");
  expect(webhook).toContain("existingStatus === 'completed'");
  expect(webhook).toContain("status: 'retry-later'");
  expect(webhook).toContain("res.status(503).json");
  expect(webhook).not.toContain('setImmediate(async () =>');
});
