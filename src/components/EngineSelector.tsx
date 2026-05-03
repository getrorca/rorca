/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/apiFetch';

export type EngineValue = 'claude' | 'opencode' | 'codex' | 'pi';

export interface EngineStatus {
  claudeAvailable?: boolean;
  opencodeAvailable?: boolean;
  codexAvailable?: boolean;
  piAvailable?: boolean;
}

interface EngineSelectorProps {
  value: EngineValue;
  onChange: (engine: EngineValue) => void;
  engineStatus?: EngineStatus;
}

interface Pill {
  value: EngineValue;
  label: string;
  available: boolean;
}

interface HealthEngines {
  claude: { installed: boolean };
  opencode: { installed: boolean; version?: string };
  codex: { installed: boolean; version?: string };
  pi: { installed: boolean; version?: string };
}

interface HealthResponse {
  engines?: HealthEngines;
}

export function EngineSelector({ value, onChange, engineStatus }: EngineSelectorProps) {
  const [fetchedStatus, setFetchedStatus] = useState<EngineStatus | null>(null);

  useEffect(() => {
    // Only fetch if no engineStatus prop is provided
    if (engineStatus !== undefined) return;

    apiFetch<HealthResponse>('/api/health', { silent: true })
      .then((data) => {
        if (data.engines) {
          setFetchedStatus({
            claudeAvailable: data.engines.claude.installed,
            opencodeAvailable: data.engines.opencode.installed,
            codexAvailable: data.engines.codex.installed,
            piAvailable: data.engines.pi.installed,
          });
        }
      })
      .catch(() => {
        // Health check failed — leave availability dots muted
      });
  }, [engineStatus]);

  const resolved = engineStatus ?? fetchedStatus ?? {};

  const pills: Pill[] = [
    {
      value: 'claude',
      label: 'Claude (Sub)',
      available: resolved.claudeAvailable ?? false,
    },
    {
      value: 'opencode',
      label: 'OpenCode (API)',
      available: resolved.opencodeAvailable ?? false,
    },
    {
      value: 'codex',
      label: 'Codex (Sub)',
      available: resolved.codexAvailable ?? false,
    },
    {
      value: 'pi',
      label: 'Pi',
      available: resolved.piAvailable ?? false,
    },
  ];

  return (
    <div
      role="group"
      aria-label="Execution engine"
      className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface-200)] p-0.5 gap-0.5"
    >
      {pills.map((pill) => {
        const isActive = value === pill.value;
        return (
          <button
            key={pill.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(pill.value)}
            className={[
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-border)]',
              isActive
                ? 'bg-[var(--accent)] text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--border)]',
            ].join(' ')}
          >
            <span
              aria-hidden="true"
              className={[
                'inline-block h-1.5 w-1.5 rounded-full shrink-0',
                pill.available ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]',
              ].join(' ')}
            />
            {pill.label}
          </button>
        );
      })}
    </div>
  );
}
