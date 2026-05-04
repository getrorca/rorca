#!/usr/bin/env npx tsx

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
    'GET /api/specs',
    'GET /api/specs/kanban',
    'GET /api/specs/archive',
    'GET /api/specs/search/stories',
    'GET /api/specs/{specId}',
    'GET /api/specs/{specId}/versions',
    'GET /api/specs/{specId}/diff',
    'GET /api/specs/{specId}/graph',
    'POST /api/specs/generate',
    'POST /api/specs/{specId}/approve',
    'POST /api/specs/{specId}/reject',
    'POST /api/specs/{specId}/add-stories',
    'PUT /api/specs/{specId}',
    'PATCH /api/specs/{specId}/stories/{storyId}',
    'DELETE /api/specs/{specId}/stories/{storyId}',
    'GET /api/pipeline/runs',
    'GET /api/pipeline/runs/{runId}',
    'GET /api/pipeline/runs/{runId}/log',
    'POST /api/pipeline/trigger',
    'POST /api/pipeline/runs/{runId}/cancel',
    'POST /api/pipeline/runs/{runId}/retry',
    'GET /api/direction',
    'PUT /api/direction',
    'POST /api/direction/synthesize',
    'GET /api/search',
    'GET /api/recall',
    'GET /api/health',
    'GET /api/version',
  ],
  auth: [
    'GET /api/users/me',
    'GET /api/settings/profile',
    'PUT /api/settings/profile',
    'GET /api/settings/display',
    'PUT /api/settings/display',
    'GET /api/settings/worker',
    'GET /api/workspaces',
    'GET /api/workspaces/{id}',
    'PATCH /api/workspaces/{id}',
    'GET /api/workspaces/{id}/stats',
    'GET /api/workspaces/{id}/health',
    'GET /api/workspaces/{id}/rorca-config',
    'PUT /api/workspaces/{id}/rorca-config',
    'GET /api/onboarding',
    'PUT /api/onboarding',
  ],
  paid: [
    'GET /api/teams',
    'POST /api/teams',
    'POST /api/teams/{id}/invites',
    'GET /api/teams/{id}/members',
    'PATCH /api/teams/{id}/members/{userId}',
    'DELETE /api/teams/{id}/members/{userId}',
    'PATCH /api/teams/{id}/settings',
    'GET /api/teams/{id}/direction',
    'PUT /api/teams/{id}/direction',
    'POST /api/teams/{id}/direction/preview',
    'GET /api/invites/{token}',
    'POST /api/invites/{token}/accept',
    'GET /api/memory/cross-workspace/{workspaceId}',
    'POST /api/memory/cross-workspace/{workspaceId}/accept/{entryId}',
    'POST /api/memory/cross-workspace/{workspaceId}/dismiss/{entryId}',
    'GET /api/workspaces/{id}/integrations/audit-log',
    'GET /api/analytics/roi',
    'PUT /api/analytics/roi/config',
    'GET /api/analytics/finops/run/{runId}',
    'GET /api/analytics/finops/historical',
    'GET /api/analytics/pi-providers',
    'GET /api/analytics/finops/export',
    'GET /api/workspaces/{id}/team-members',
    'POST /api/marketplace/publish',
    'POST /api/marketplace/{id}/fork',
  ],
  admin: [
    'POST /api/admin/backup',
    'GET /api/admin/backups',
    'POST /api/admin/embed-all',
    'GET /api/admin/embed-all/status',
    'GET /api/admin/embedding-provider',
    'GET /api/admin/mcp-audit',
    'GET /api/admin/mcp-audit/summary',
    'POST /api/admin/graph-backfill',
    'GET /api/admin/graph-stats',
    'POST /api/admin/age-recheck',
    'POST /api/admin/generate-license',
    'POST /api/graph/populate',
  ],
};

const SENSITIVE_PREFIXES = [
  '/api/vault',
  '/api/terminal',
  '/api/webhooks',
  '/api/auth',
  '/api/copilot',
];

const SENSITIVE_EXACT = new Set([
  'POST /api/workspaces',
]);

const EXPECTED_PAID_CAPABILITIES: Record<string, PlanCapability> = {
  'GET /api/teams': 'teams',
  'POST /api/teams': 'teams',
  'POST /api/teams/{id}/invites': 'teams',
  'GET /api/teams/{id}/members': 'teams',
  'PATCH /api/teams/{id}/members/{userId}': 'teams',
  'DELETE /api/teams/{id}/members/{userId}': 'teams',
  'PATCH /api/teams/{id}/settings': 'teams',
  'GET /api/teams/{id}/direction': 'teams',
  'PUT /api/teams/{id}/direction': 'teams',
  'POST /api/teams/{id}/direction/preview': 'teams',
  'GET /api/invites/{token}': 'teams',
  'POST /api/invites/{token}/accept': 'teams',
  'GET /api/memory/cross-workspace/{workspaceId}': 'federatedMemory',
  'POST /api/memory/cross-workspace/{workspaceId}/accept/{entryId}': 'federatedMemory',
  'POST /api/memory/cross-workspace/{workspaceId}/dismiss/{entryId}': 'federatedMemory',
  'GET /api/workspaces/{id}/integrations/audit-log': 'grcAuditTraces',
  'GET /api/analytics/roi': 'finops',
  'PUT /api/analytics/roi/config': 'finops',
  'GET /api/analytics/finops/run/{runId}': 'finops',
  'GET /api/analytics/finops/historical': 'finops',
  'GET /api/analytics/pi-providers': 'finops',
  'GET /api/analytics/finops/export': 'finops',
  'GET /api/workspaces/{id}/team-members': 'teams',
  'POST /api/marketplace/publish': 'marketplacePublish',
  'POST /api/marketplace/{id}/fork': 'marketplacePublish',
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
