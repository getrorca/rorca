/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { RequestHandler } from 'express';
import { getDatabaseCapability, type DatabaseCapability } from './db-strategy';

let cachedCapability: DatabaseCapability | null = null;
let cachedCapabilityCheckedAt = 0;
const CAPABILITY_NEGATIVE_TTL_MS = 60_000;

export async function getCachedDatabaseCapability(): Promise<DatabaseCapability> {
  if (cachedCapability && cachedCapability.graphMode === 'full') {
    return cachedCapability;
  }

  if (cachedCapability) {
    const elapsed = Date.now() - cachedCapabilityCheckedAt;
    if (elapsed < CAPABILITY_NEGATIVE_TTL_MS) {
      return cachedCapability;
    }
    cachedCapability = null;
  }

  cachedCapability = await getDatabaseCapability();
  cachedCapabilityCheckedAt = Date.now();
  return cachedCapability;
}

export async function checkAge(): Promise<boolean> {
  const capability = await getCachedDatabaseCapability();
  return capability.extensions.age;
}

export function invalidateAgeCache(): void {
  cachedCapability = null;
  cachedCapabilityCheckedAt = 0;
}

export function getAgeUnavailableBody(): {
  error: string;
  code: 'AGE_NOT_INSTALLED';
  mode: 'lite' | 'disabled';
  hint: string;
  capability: DatabaseCapability;
} {
  const fallbackCapability: DatabaseCapability = cachedCapability ?? {
    dbMode: 'native',
    provider: 'native-postgres',
    extensions: { age: false, vector: false, pgcrypto: false },
    graphMode: 'lite',
    warnings: ['Apache AGE is unavailable.'],
    connection: {
      url: null,
      host: null,
      port: null,
      database: null,
      local: true,
    },
    connected: false,
  };

  return {
    error: 'Apache AGE extension not available',
    code: 'AGE_NOT_INSTALLED',
    mode: fallbackCapability.graphMode === 'disabled' ? 'disabled' : 'lite',
    hint: fallbackCapability.dbMode === 'docker'
      ? 'Run `rorca db start` to ensure the Docker Postgres sidecar is ready with Apache AGE enabled.'
      : 'Run `rorca db start` to enable Docker Postgres with Apache AGE, or install Apache AGE on your current Postgres instance.',
    capability: fallbackCapability,
  };
}

export function requireAge(): RequestHandler {
  return async (_req, res, next) => {
    if (!(await checkAge())) {
      res.status(503).json(getAgeUnavailableBody());
      return;
    }
    next();
  };
}
