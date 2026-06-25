/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiFetch } from '../lib/apiFetch';

interface Capabilities {
  age: boolean;
  vector: boolean;
}

export interface DatabaseCapability {
  dbMode: 'native' | 'docker' | 'byop';
  provider: string;
  extensions: {
    age: boolean;
    vector: boolean;
    pgcrypto?: boolean;
  };
  graphMode: 'full' | 'lite' | 'disabled';
  warnings: string[];
  connection: {
    url: string | null;
    host: string | null;
    port: number | null;
    database: string | null;
    local: boolean;
  };
  connected: boolean;
}

interface VersionPayload {
  version: string;
  mode: 'native' | 'docker' | 'byop';
  capabilities: Capabilities;
  databaseCapability?: DatabaseCapability;
}

interface CapabilitiesContextValue {
  capabilities: Capabilities | null;
  mode: VersionPayload['mode'] | null;
  databaseCapability: DatabaseCapability | null;
  refreshCapabilities: () => Promise<void>;
  recheckAge: () => Promise<boolean>;
}

const CapabilitiesContext = createContext<CapabilitiesContextValue | null>(null);

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [mode, setMode] = useState<VersionPayload['mode'] | null>(null);
  const [databaseCapability, setDatabaseCapability] = useState<DatabaseCapability | null>(null);

  const refreshCapabilities = useCallback(async () => {
    const payload = await apiFetch<VersionPayload>('/api/version', { silent: true });
    setCapabilities(payload.capabilities);
    setMode(payload.databaseCapability?.dbMode ?? payload.mode);
    setDatabaseCapability(payload.databaseCapability ?? null);
  }, []);

  const recheckAge = useCallback(async (): Promise<boolean> => {
    await apiFetch<{ ok: boolean; age: boolean }>('/api/admin/age-recheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      silent: true,
    });
    const payload = await apiFetch<VersionPayload>('/api/version', { silent: true });
    setCapabilities(payload.capabilities);
    setMode(payload.databaseCapability?.dbMode ?? payload.mode);
    setDatabaseCapability(payload.databaseCapability ?? null);
    return payload.databaseCapability?.extensions.age ?? payload.capabilities.age;
  }, []);

  useEffect(() => {
    void refreshCapabilities().catch(() => {
      setCapabilities(null);
      setMode(null);
      setDatabaseCapability(null);
    });
  }, [refreshCapabilities]);

  const value = useMemo<CapabilitiesContextValue>(() => ({
    capabilities,
    mode,
    databaseCapability,
    refreshCapabilities,
    recheckAge,
  }), [capabilities, mode, databaseCapability, refreshCapabilities, recheckAge]);

  return (
    <CapabilitiesContext.Provider value={value}>
      {children}
    </CapabilitiesContext.Provider>
  );
}

export function useCapabilities() {
  const ctx = useContext(CapabilitiesContext);
  if (!ctx) throw new Error('useCapabilities must be used within CapabilitiesProvider');
  return ctx;
}
