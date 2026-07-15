#!/usr/bin/env npx tsx
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { swaggerSpec } from '../backend/src/lib/swagger';
import tierSnapshot from '../config/rorca-tier-snapshot.json';
import {
  getRorcaTier,
  isPlanCapability,
  PLAN_CAPABILITY_KEYS,
  summarizeRorcaTiers,
  type PlanCapability,
  type RorcaTier,
} from '../backend/src/lib/tier-auth';

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

// Reviewed tier baseline. Keeping it in a dedicated manifest makes exposure
// changes explicit in code review instead of silently accepting new annotations.
const EXPECTED = tierSnapshot as Record<RorcaTier, string[]>;
const PUBLIC_NON_CONTRACT_OPERATIONS = new Set([
  'GET /api/health/detailed',
  'GET /api/pipeline/runs/{runId}/output',
  'POST /api/pipeline/runs/{runId}/input',
  'POST /api/pipeline/runs/{runId}/pty/resize',
]);
const EXPECTED_PUBLIC_API = new Set(
  EXPECTED.public.filter((operation) => !PUBLIC_NON_CONTRACT_OPERATIONS.has(operation)),
);

const SENSITIVE_PREFIXES = [
  '/api/vault',
  '/api/terminal',
  '/api/webhooks',
  '/api/auth',
];

const SENSITIVE_EXACT = new Set<string>();

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
    if (EXPECTED_PUBLIC_API.has(key) && metadata.publicApi !== true) {
      errors.push(`Stable public route ${key} must include x-rorca-public-api: true`);
    }
    if (!EXPECTED_PUBLIC_API.has(key) && metadata.publicApi === true) {
      errors.push(`Non-contract route ${key} must not include x-rorca-public-api: true`);
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

  if (summary.publicApi !== EXPECTED_PUBLIC_API.size) {
    errors.push(`Public API count mismatch: got ${summary.publicApi}, expected ${EXPECTED_PUBLIC_API.size}`);
  }

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
