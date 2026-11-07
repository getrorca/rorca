/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { recordSecretAccessAudit } from '../db/execution-authority-secret-access';
import { ValidationError } from './errors';
import {
  DatabaseVaultSecretStore,
  InfisicalSecretStore,
  type InfisicalTransport,
  type SecretAccessAuditWriter,
  type SecretStore,
} from './secret-store';

export type AuthoritySecretStoreConfig =
  | { backend: 'database' }
  | {
      backend: 'infisical';
      endpoint: string;
      online: boolean;
      timeoutMs: number;
      maximumStalenessMs: number;
    };

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/** Parses backend selection only; no provider credential is accepted here. */
export function parseAuthoritySecretStoreConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AuthoritySecretStoreConfig {
  const backend = env.RORCA_AUTHORITY_SECRET_STORE?.trim().toLowerCase() || 'database';
  if (backend === 'database') return { backend };
  if (backend !== 'infisical') {
    throw new ValidationError('RORCA_AUTHORITY_SECRET_STORE must be database or infisical');
  }
  const rawEndpoint = env.RORCA_AUTHORITY_INFISICAL_ENDPOINT?.trim();
  if (!rawEndpoint) throw new ValidationError('RORCA_AUTHORITY_INFISICAL_ENDPOINT is required for Infisical');
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new ValidationError('RORCA_AUTHORITY_INFISICAL_ENDPOINT must be an absolute URL');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ValidationError('RORCA_AUTHORITY_INFISICAL_ENDPOINT must be credential-free HTTPS');
  }
  const offline = env.RORCA_AUTHORITY_INFISICAL_OFFLINE?.trim().toLowerCase();
  if (offline !== undefined && !['true', 'false'].includes(offline)) {
    throw new ValidationError('RORCA_AUTHORITY_INFISICAL_OFFLINE must be true or false');
  }
  return {
    backend,
    endpoint: endpoint.toString().replace(/\/$/, ''),
    online: offline !== 'true',
    timeoutMs: boundedInteger(env.RORCA_AUTHORITY_INFISICAL_TIMEOUT_MS, 2_000, 10, 10_000, 'RORCA_AUTHORITY_INFISICAL_TIMEOUT_MS'),
    maximumStalenessMs: boundedInteger(
      env.RORCA_AUTHORITY_INFISICAL_MAX_STALENESS_MS,
      60_000,
      0,
      24 * 60 * 60 * 1000,
      'RORCA_AUTHORITY_INFISICAL_MAX_STALENESS_MS',
    ),
  };
}

export interface ConfiguredSecretStoreDependencies {
  databaseStore?: SecretStore;
  infisicalTransport?: InfisicalTransport;
  audit?: SecretAccessAuditWriter;
  now?: () => Date;
}

/**
 * Database is the unconditional zero-network default. Selecting Infisical
 * without an explicitly injected transport fails closed; ambient credentials
 * and fallback to the database vault are intentionally absent.
 */
export function createConfiguredSecretStore(
  config: AuthoritySecretStoreConfig = parseAuthoritySecretStoreConfig(),
  dependencies: ConfiguredSecretStoreDependencies = {},
): SecretStore {
  if (config.backend === 'database') return dependencies.databaseStore ?? new DatabaseVaultSecretStore();
  if (!dependencies.infisicalTransport) {
    throw new ValidationError('Infisical authority secret store requires an explicit credential-free transport');
  }
  return new InfisicalSecretStore(config, {
    transport: dependencies.infisicalTransport,
    audit: dependencies.audit ?? recordSecretAccessAudit,
    now: dependencies.now ?? (() => new Date()),
  });
}
