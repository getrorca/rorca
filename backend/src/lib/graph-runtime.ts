/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { DatabaseCapability, GraphMode } from './db-strategy';
import * as ageGuard from './age-guard';

export type GraphSurface = 'knowledge' | 'memory' | 'relevance' | 'admin';
export type GraphProvider = 'age' | 'relational' | 'semantic' | 'none';

export interface GraphRuntimeDescriptor {
  graphMode: GraphMode;
  provider: GraphProvider;
  ageAvailable: boolean;
  hint: string;
  message: string;
}

export interface RuntimeGraphCapability extends GraphRuntimeDescriptor {
  surface: GraphSurface;
  available: boolean;
  adminAvailable: boolean;
  capability: DatabaseCapability;
}

function fullGraphHint(capability: DatabaseCapability): string {
  return capability.dbMode === 'docker'
    ? 'Docker Postgres with Apache AGE is active.'
    : 'Apache AGE is active on the current Postgres instance.';
}

function liteGraphHint(capability: DatabaseCapability): string {
  return capability.dbMode === 'docker'
    ? 'Run `rorca db start` to ensure the Docker Postgres sidecar is ready with Apache AGE enabled.'
    : 'Install Apache AGE on the current Postgres instance or switch to `rorca db start` for the full graph stack.';
}

function disabledGraphHint(capability: DatabaseCapability): string {
  return capability.dbMode === 'docker'
    ? 'Run `rorca db start` to bring the local database online.'
    : 'Check the current Postgres connection and reconnect before using graph features.';
}

function surfaceProvider(surface: GraphSurface, graphMode: GraphMode): GraphProvider {
  if (graphMode === 'full') return 'age';
  if (graphMode === 'disabled') return 'none';
  if (surface === 'relevance') return 'semantic';
  if (surface === 'admin') return 'none';
  return 'relational';
}

function surfaceMessage(surface: GraphSurface, graphMode: GraphMode): string {
  if (graphMode === 'full') {
    switch (surface) {
      case 'relevance':
        return 'Full graph mode active. Graph/path evidence can be included when telemetry captured it.';
      case 'admin':
        return 'Full graph mode active. AGE-backed admin operations are available.';
      default:
        return 'Full graph mode active. Apache AGE-backed graph projections are available.';
    }
  }

  if (graphMode === 'lite') {
    switch (surface) {
      case 'relevance':
        return 'Graph Lite active. Relevance graph uses semantic and telemetry evidence without AGE graph paths.';
      case 'admin':
        return 'Graph Lite active. AGE-only admin operations are unavailable until Apache AGE is enabled.';
      default:
        return 'Graph Lite active. This surface uses relational fallback data instead of Apache AGE.';
    }
  }

  return 'Graph features are disabled because the current database connection is unavailable.';
}

export function describeRuntimeGraph(runtime: RuntimeGraphCapability): GraphRuntimeDescriptor {
  return {
    graphMode: runtime.graphMode,
    provider: runtime.provider,
    ageAvailable: runtime.ageAvailable,
    hint: runtime.hint,
    message: runtime.message,
  };
}

async function getCapabilityForRuntime(): Promise<DatabaseCapability> {
  if (typeof ageGuard.getCachedDatabaseCapability === 'function') {
    return ageGuard.getCachedDatabaseCapability();
  }

  const ageAvailable = typeof ageGuard.checkAge === 'function'
    ? await ageGuard.checkAge()
    : false;

  return {
    dbMode: 'native',
    provider: 'native-postgres',
    extensions: { age: ageAvailable, vector: false, pgcrypto: false },
    graphMode: ageAvailable ? 'full' : 'lite',
    warnings: ageAvailable ? [] : ['Apache AGE is unavailable.'],
    connection: {
      url: null,
      host: null,
      port: null,
      database: null,
      local: true,
    },
    connected: true,
  };
}

export async function getRuntimeGraphCapability(surface: GraphSurface): Promise<RuntimeGraphCapability> {
  const capability = await getCapabilityForRuntime();
  const graphMode = capability.graphMode;
  const provider = surfaceProvider(surface, graphMode);

  return {
    surface,
    capability,
    graphMode,
    provider,
    ageAvailable: capability.extensions.age,
    available: graphMode !== 'disabled' && surface !== 'admin',
    adminAvailable: graphMode === 'full',
    hint: graphMode === 'full'
      ? fullGraphHint(capability)
      : graphMode === 'lite'
        ? liteGraphHint(capability)
        : disabledGraphHint(capability),
    message: surfaceMessage(surface, graphMode),
  };
}
