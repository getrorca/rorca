/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { fetchOpenApiFromServer } from '../packages/rorca-public-contract/src/index';

/**
 * Load this checkout's OpenAPI document by default so local contract commands
 * cannot accidentally inspect an unrelated Rorca process already on port 3030.
 * CI sets RORCA_CONTRACT_BASE_URL to verify the served document instead.
 */
export async function loadOpenApiDocument(): Promise<unknown> {
  const baseUrl = process.env.RORCA_CONTRACT_BASE_URL?.trim();
  if (baseUrl) {
    return fetchOpenApiFromServer(baseUrl);
  }

  // Explicit extension avoids Node/tsx resolving a tracked stale swagger.js
  // sibling ahead of the current TypeScript source.
  const sourceModule = '../backend/src/lib/swagger.ts';
  const { swaggerSpec } = await import(sourceModule);
  return swaggerSpec;
}
