#!/usr/bin/env npx tsx

/**
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
const CONTRACT_SNAPSHOT_PATH = path.join(__dirname, '../docs/openapi-public-snapshot.json');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

const SENSITIVE_PREFIXES = [
  '/api/vault',
  '/api/terminal',
  '/api/webhooks',
  '/api/auth',
];

const SENSITIVE_PATH_PARTS = [
  '/env-vars',
  '/skills/install',
];

const EXPECTED_PAID_CAPABILITIES: Record<string, PlanCapability> = {};

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

type ContractSnapshot = {
  routes?: Array<{ method?: string; path?: string }>;
};

function contractLine(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

function collectOperations(paths: SpecPaths): Map<string, Operation> {
  const operations = new Map<string, Operation>();

  for (const [pathname, methods] of Object.entries(paths)) {
    if (!methods) continue;
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation || !HTTP_METHODS.has(method.toLowerCase())) continue;
      operations.set(contractLine(method, pathname), operation);
    }
  }

  return operations;
}

function readPublicContractSnapshot(): Set<string> | null {
  if (!fs.existsSync(CONTRACT_SNAPSHOT_PATH)) return null;
  const parsed = JSON.parse(fs.readFileSync(CONTRACT_SNAPSHOT_PATH, 'utf8')) as ContractSnapshot;
  return new Set(
    (parsed.routes ?? [])
      .filter((route) => route.method && route.path)
      .map((route) => contractLine(String(route.method), String(route.path))),
  );
}

function isValidTier(raw: unknown): raw is RorcaTier {
  return raw === 'public' || raw === 'auth' || raw === 'paid' || raw === 'admin';
}

function isSensitiveRoute(key: string): boolean {
  const pathname = key.slice(key.indexOf(' ') + 1);
  return SENSITIVE_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    SENSITIVE_PATH_PARTS.some((part) => pathname.includes(part));
}

function main(): void {
  const paths = (swaggerSpec as { paths?: SpecPaths }).paths ?? {};
  const operations = collectOperations(paths);
  const errors: string[] = [];

  for (const [key, operation] of operations) {
    const rawTier = operation['x-rorca-tier'];
    if (rawTier !== undefined && !isValidTier(rawTier)) {
      errors.push(`Route ${key} has invalid x-rorca-tier '${rawTier}'`);
      continue;
    }

    const metadata = getRorcaTier(operation);
    if (metadata.tier === 'denied') {
      if (metadata.publicApi === true) {
        errors.push(`Default-denied route ${key} must not include x-rorca-public-api: true`);
      }
      continue;
    }

    if (!metadata.rationale) {
      errors.push(`Route ${key} is missing x-rorca-rationale`);
    }

    if (metadata.tier !== 'public' && metadata.publicApi === true) {
      errors.push(`Non-public route ${key} must not include x-rorca-public-api: true`);
    }

    if (metadata.tier === 'paid') {
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

    if (isSensitiveRoute(key)) {
      errors.push(`Sensitive route must remain default-denied: ${key}`);
    }
  }

  const publicApiOperations = new Set(
    Array.from(operations.entries())
      .filter(([, operation]) => {
        const metadata = getRorcaTier(operation);
        return metadata.tier === 'public' && metadata.publicApi === true;
      })
      .map(([key]) => key),
  );

  const committedContract = readPublicContractSnapshot();
  if (committedContract) {
    for (const key of publicApiOperations) {
      if (!committedContract.has(key)) {
        errors.push(`Public API route ${key} is annotated but missing from docs/openapi-public-snapshot.json`);
      }
    }
    for (const key of committedContract) {
      if (!publicApiOperations.has(key)) {
        errors.push(`Public API snapshot route ${key} is missing a public x-rorca-public-api annotation`);
      }
    }
  }

  const summary = summarizeRorcaTiers(swaggerSpec as any);

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
