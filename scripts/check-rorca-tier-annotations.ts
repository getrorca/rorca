#!/usr/bin/env npx tsx
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */


import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { swaggerSpec } from '../backend/src/lib/swagger';
import {
  getRorcaTier,
  isPlanCapability,
  PLAN_CAPABILITY_KEYS,
  summarizeRorcaTiers,
  type PlanCapability,
  type RorcaTier,
} from '../backend/src/lib/tier-auth';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONTRACT_PATH = path.join(__dirname, '../docs/OPEN_API_CONTRACT.md');

type Operation = {
  summary?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  requestBody?: {
    content?: {
      'application/json'?: {
        schema?: {
          required?: string[];
          properties?: Record<string, unknown>;
        };
      };
    };
  };
  'x-rorca-tier'?: string;
  'x-rorca-capability'?: string;
  'x-rorca-rationale'?: string;
  'x-rorca-public-api'?: boolean;
};

type SpecPaths = Record<string, Record<string, Operation | undefined> | undefined>;

const EXPECTED: Record<RorcaTier, string[]> = {
  public: [
    'DELETE /api/memory/relations/{id}',
    'DELETE /api/specs/{specId}/stories/{storyId}',
    'GET /api/analytics/ontology-health',
    'GET /api/candidates',
    'GET /api/candidates/{id}',
    'GET /api/context-events/health',
    'GET /api/context/health/{workspaceId}',
    'GET /api/direction',
    'GET /api/graph/stats',
    'GET /api/health',
    'GET /api/health/detailed',
    'GET /api/mcp/tools',
    'GET /api/memory',
    'GET /api/memory/categories',
    'GET /api/memory/context',
    'GET /api/memory/graph/neighborhood',
    'GET /api/memory/graph/overview',
    'GET /api/memory/items',
    'GET /api/memory/relations',
    'GET /api/memory/review',
    'GET /api/pipeline/runs',
    'GET /api/pipeline/runs/{runId}',
    'GET /api/pipeline/runs/{runId}/context-trace/{rawRef}',
    'GET /api/pipeline/runs/{runId}/log',
    'GET /api/pipeline/runs/{runId}/output',
    'GET /api/pipeline/runs/{runId}/retrieval-telemetry/{telemetryId}',
    'GET /api/recall',
    'GET /api/retrieval-traces',
    'GET /api/retrieval-traces/{traceId}',
    'GET /api/search',
    'GET /api/spec-jobs/{jobId}',
    'GET /api/spec-jobs/{jobId}/stream',
    'GET /api/spec-relevance-graph',
    'GET /api/spec-relevance-graph/by-run/{runId}',
    'GET /api/spec-relevance-graph/by-spec/{specSlug}',
    'GET /api/specs',
    'GET /api/specs/archive',
    'GET /api/specs/forge/batch/{batchId}',
    'GET /api/specs/forge/batch/{batchId}/stream',
    'GET /api/specs/kanban',
    'GET /api/specs/repair-candidates',
    'GET /api/specs/search/stories',
    'GET /api/specs/{specId}',
    'GET /api/specs/{specId}/diff',
    'GET /api/specs/{specId}/generation-log',
    'GET /api/specs/{specId}/graph',
    'GET /api/specs/{specId}/knowledge-graph',
    'GET /api/specs/{specId}/readiness',
    'GET /api/specs/{specId}/versions',
    'GET /api/specs/{specId}/workflow',
    'GET /api/version',
    'GET /api/workspaces/{workspaceId}/hydration',
    'PATCH /api/memory/relations/{id}',
    'PATCH /api/specs/{specId}/stories/{storyId}',
    'POST /api/candidates',
    'POST /api/candidates/{id}/approve',
    'POST /api/candidates/{id}/mark-duplicate',
    'POST /api/candidates/{id}/mark-superseded',
    'POST /api/candidates/{id}/reject',
    'POST /api/candidates/{id}/revisit',
    'POST /api/context-events/candidates',
    'POST /api/context-events/events',
    'POST /api/context-events/flush',
    'POST /api/context/enrich/async',
    'POST /api/context/retrieve',
    'POST /api/diagnostics/capture-status',
    'POST /api/direction/synthesize',
    'POST /api/events',
    'POST /api/memory',
    'POST /api/memory/relations',
    'POST /api/memory/review/{id}/action',
    'POST /api/pipeline/runs/{runId}/cancel',
    'POST /api/pipeline/runs/{runId}/input',
    'POST /api/pipeline/runs/{runId}/pty/resize',
    'POST /api/pipeline/runs/{runId}/retry',
    'POST /api/pipeline/trigger',
    'POST /api/pipeline/task-manifests/trigger',
    'POST /api/retrieval-traces',
    'POST /api/spec-jobs/{jobId}/cancel',
    'POST /api/specs/context-preview',
    'POST /api/specs/forge',
    'POST /api/specs/forge/batch',
    'POST /api/specs/generate',
    'POST /api/specs/generation-context',
    'POST /api/specs/persist',
    'POST /api/specs/{specId}/add-stories',
    'POST /api/specs/{specId}/approve',
    'POST /api/specs/{specId}/enrich',
    'POST /api/specs/{specId}/enrich/async',
    'POST /api/specs/{specId}/match-skills/async',
    'POST /api/specs/{specId}/reject',
    'POST /api/specs/{specId}/suggest-skills/async',
    'POST /api/workspaces/{workspaceId}/hydration',
    'PUT /api/direction',
    'PUT /api/specs/{specId}',
  ],
  auth: [
    'GET /api/onboarding',
    'GET /api/settings/display',
    'GET /api/settings/profile',
    'GET /api/settings/worker',
    'GET /api/users/me',
    'GET /api/workspaces',
    'GET /api/workspaces/{id}',
    'GET /api/workspaces/{id}/context-routing',
    'GET /api/workspaces/{id}/github',
    'GET /api/workspaces/{id}/github/account',
    'GET /api/workspaces/{id}/github/workflows',
    'GET /api/workspaces/{id}/health',
    'GET /api/workspaces/{id}/rorca-config',
    'GET /api/workspaces/{id}/stats',
    'GET /api/workspaces/{id}/status',
    'PATCH /api/workspaces/{id}',
    'POST /api/specs/repair-batch',
    'POST /api/specs/{specId}/repair',
    'POST /api/specs/{specId}/workflow/stages/{stageKey}/retry',
    'POST /api/workspaces/{id}/github/connect',
    'POST /api/workspaces/{id}/github/pr-template-preview',
    'POST /api/workspaces/{id}/github/webhook-ping',
    'PUT /api/onboarding',
    'PUT /api/settings/display',
    'PUT /api/settings/profile',
    'PUT /api/workspaces/{id}/rorca-config',
  ],
  paid: [
    'DELETE /api/finops/billing-profiles/{id}',
    'GET /api/analytics/finops/export',
    'GET /api/analytics/finops/historical',
    'GET /api/analytics/finops/run/{runId}',
    'GET /api/analytics/pi-providers',
    'GET /api/analytics/roi',
    'GET /api/finops/billing-profiles',
    'GET /api/finops/billing-profiles/{id}',
    'GET /api/memory/cross-workspace/{workspaceId}',
    'GET /api/workspaces/{id}/team-members',
    'POST /api/finops/billing-profiles',
    'POST /api/marketplace/publish',
    'POST /api/marketplace/{id}/fork',
    'POST /api/memory/cross-workspace/{workspaceId}/accept/{entryId}',
    'POST /api/memory/cross-workspace/{workspaceId}/dismiss/{entryId}',
    'PUT /api/analytics/roi/config',
    'PUT /api/finops/billing-profiles/{id}',
  ],
  admin: [
    'GET /api/admin/backups',
    'GET /api/admin/embed-all/status',
    'GET /api/admin/embedding-provider',
    'GET /api/admin/graph-stats',
    'GET /api/admin/mcp-audit',
    'GET /api/admin/mcp-audit/summary',
    'GET /api/diagnostics/capture-status/{workspaceId}',
    'GET /api/diagnostics/status',
    'GET /api/graph/retrieval-telemetry',
    'POST /api/admin/age-recheck',
    'POST /api/admin/backup',
    'POST /api/admin/embed-all',
    'POST /api/admin/generate-license',
    'POST /api/admin/graph-backfill',
    'POST /api/graph/populate',
  ],
};

const SENSITIVE_PREFIXES = [
  '/api/vault',
  '/api/terminal',
  '/api/webhooks',
  '/api/auth',
];

const SENSITIVE_EXACT = new Set([
  'POST /api/workspaces',
]);

const EXPECTED_PAID_CAPABILITIES: Record<string, PlanCapability> = {
};

function contractLine(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

function collectOperations(paths: SpecPaths): Map<string, Operation> {
  const operations = new Map<string, Operation>();

  for (const [pathname, methods] of Object.entries(paths)) {
    if (!methods) continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation) continue;
      operations.set(contractLine(method, pathname), operation);
    }
  }

  return operations;
}

function listParams(operation: Operation): string[] {
  const params = (operation.parameters ?? []).map((param) => {
    const suffix = param.required ? 'required' : 'optional';
    return `${param.in}:${param.name} (${suffix})`;
  });

  const jsonSchema = operation.requestBody?.content?.['application/json']?.schema;
  const required = new Set(jsonSchema?.required ?? []);

  for (const name of Object.keys(jsonSchema?.properties ?? {})) {
    params.push(`body:${name} (${required.has(name) ? 'required' : 'optional'})`);
  }

  return params;
}

function writeContract(publicOperations: Array<[string, Operation]>): void {
  const lines: string[] = [
    '# Open API Contract',
    '',
    'Stable public API surface for the open-source CLI.',
    '',
    '| Method | Path | Parameters | Summary |',
    '| --- | --- | --- | --- |',
  ];

  for (const [key, operation] of publicOperations.sort(([a], [b]) => a.localeCompare(b))) {
    const firstSpace = key.indexOf(' ');
    const method = key.slice(0, firstSpace);
    const pathname = key.slice(firstSpace + 1);
    const params = listParams(operation).join(', ') || '-';
    const summary = operation.summary ?? '-';
    lines.push(`| ${method} | \`${pathname}\` | ${params} | ${summary} |`);
  }

  fs.mkdirSync(path.dirname(CONTRACT_PATH), { recursive: true });
  fs.writeFileSync(CONTRACT_PATH, `${lines.join('\n')}\n`, 'utf8');
}

function main(): void {
  const paths = (swaggerSpec as { paths?: SpecPaths }).paths ?? {};
  const operations = collectOperations(paths);
  const expectedEntries = new Map<string, RorcaTier>();

  for (const [tier, entries] of Object.entries(EXPECTED) as Array<[RorcaTier, string[]]>) {
    for (const entry of entries) {
      expectedEntries.set(entry, tier);
    }
  }

  const errors: string[] = [];

  for (const [key, expectedTier] of expectedEntries) {
    const operation = operations.get(key);
    if (!operation) {
      errors.push(`Missing swagger operation for expected tiered route: ${key}`);
      continue;
    }

    const metadata = getRorcaTier(operation);
    if (metadata.tier !== expectedTier) {
      errors.push(`Route ${key} expected tier ${expectedTier} but found ${metadata.tier}`);
    }
    if (!metadata.rationale) {
      errors.push(`Route ${key} is missing x-rorca-rationale`);
    }
    if (expectedTier === 'paid') {
      const rawCapability = operation['x-rorca-capability'];
      if (!isPlanCapability(rawCapability)) {
        errors.push(
          `Paid route ${key} must include valid x-rorca-capability (${PLAN_CAPABILITY_KEYS.join(', ')})`,
        );
      } else if (EXPECTED_PAID_CAPABILITIES[key] && rawCapability !== EXPECTED_PAID_CAPABILITIES[key]) {
        errors.push(
          `Paid route ${key} expected capability ${EXPECTED_PAID_CAPABILITIES[key]} but found ${rawCapability}`,
        );
      }
    }
    if (expectedTier === 'public' && metadata.publicApi !== true) {
      errors.push(`Public route ${key} must include x-rorca-public-api: true`);
    }
    if (expectedTier !== 'public' && metadata.publicApi === true) {
      errors.push(`Non-public route ${key} must not include x-rorca-public-api: true`);
    }
  }

  for (const [key, operation] of operations) {
    const metadata = getRorcaTier(operation);
    if (metadata.tier === 'denied') continue;

    if (!expectedEntries.has(key)) {
      errors.push(`Unexpected tier annotation on ${key} (${metadata.tier})`);
    }
    if (metadata.tier === 'paid' && !expectedEntries.has(key)) {
      const rawCapability = operation['x-rorca-capability'];
      if (!isPlanCapability(rawCapability)) {
        errors.push(
          `Paid route ${key} must include valid x-rorca-capability (${PLAN_CAPABILITY_KEYS.join(', ')})`,
        );
      }
    }

    const pathname = key.slice(key.indexOf(' ') + 1);
    if (
      SENSITIVE_EXACT.has(key) ||
      pathname.includes('/env-vars') ||
      pathname.includes('/skills/install') ||
      SENSITIVE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ) {
      errors.push(`Sensitive route must remain default-denied: ${key}`);
    }
  }

  const summary = summarizeRorcaTiers(swaggerSpec as any);

  if (
    summary.public !== EXPECTED.public.length ||
    summary.auth !== EXPECTED.auth.length ||
    summary.paid !== EXPECTED.paid.length ||
    summary.admin !== EXPECTED.admin.length
  ) {
    errors.push(
      `Tier count mismatch: got ${summary.public}/${summary.auth}/${summary.paid}/${summary.admin}, expected ${EXPECTED.public.length}/${EXPECTED.auth.length}/${EXPECTED.paid.length}/${EXPECTED.admin.length}`,
    );
  }

  if (summary.publicApi !== EXPECTED.public.length) {
    errors.push(`Public API count mismatch: got ${summary.publicApi}, expected ${EXPECTED.public.length}`);
  }

  const publicOperations = Array.from(operations.entries()).filter(([_, operation]) => {
    const metadata = getRorcaTier(operation);
    return metadata.tier === 'public' && metadata.publicApi === true;
  });

  writeContract(publicOperations);

  for (const error of errors) {
    console.error(`[Tier Lint] ERROR ${error}`);
  }

  console.log(
    `[Tier Lint] Tier exposure: ${summary.public} public, ${summary.auth} auth, ${summary.paid} paid, ${summary.admin} admin (${summary.denied} default-denied)`,
  );
  console.log(`[Tier Lint] Open-source CLI public API surface: ${summary.publicApi} routes`);
  console.log(`[Tier Lint] MCP-exposed (public + auth): ${summary.public + summary.auth} tools`);

  process.exit(errors.length > 0 ? 1 : 0);
}

main();
