/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import pkg from '../package.json' with { type: 'json' };

export const CLI_VERSION = pkg.version;
export const MIN_BACKEND_VERSION = '0.1.0';
export const MIN_BACKEND_API_VERSION = '1.0';

export interface VersionResponse {
  version: string;
  apiVersion: string;
  schemaVersion: string | null;
  minCliVersion: string;
  capabilities: {
    pi: boolean;
    docker: boolean;
    age: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface VersionCheckResult {
  ok: boolean;
  reason?: string;
  backend?: VersionResponse;
}

function parseSemver(input: string): [number, number, number] | null {
  const match = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

export function semverGte(left: string, right: string): boolean {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return left === right;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return true;
    if (a[index] < b[index]) return false;
  }
  return true;
}

export async function checkVersion(backendUrl: string): Promise<VersionCheckResult> {
  const baseUrl = backendUrl.replace(/\/$/, '');

  try {
    const response = await fetch(`${baseUrl}/api/version`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      return { ok: false, reason: `Backend health check failed (${response.status})` };
    }

    const backend = await response.json() as VersionResponse;

    if (!semverGte(backend.version, MIN_BACKEND_VERSION)) {
      return {
        ok: false,
        reason: `Backend ${backend.version} < required ${MIN_BACKEND_VERSION}`,
        backend,
      };
    }

    if (backend.apiVersion !== MIN_BACKEND_API_VERSION) {
      return {
        ok: false,
        reason: `API version ${backend.apiVersion} != ${MIN_BACKEND_API_VERSION}`,
        backend,
      };
    }

    if (!semverGte(CLI_VERSION, backend.minCliVersion)) {
      return {
        ok: false,
        reason: `CLI ${CLI_VERSION} < backend minimum ${backend.minCliVersion}`,
        backend,
      };
    }

    return { ok: true, backend };
  } catch {
    return { ok: false, reason: `Cannot reach backend at ${baseUrl}` };
  }
}
