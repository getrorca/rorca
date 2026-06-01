/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export interface VaultKeyResult {
  key: any;
  baseUrl: any;
}

export async function getVaultKey(_workspaceId: string | number, _keyName: string): Promise<VaultKeyResult | null> {
  return null;
}

export async function getOpenRouterPrefs(..._args: unknown[]): Promise<Record<string, unknown> | null> {
  return null;
}
