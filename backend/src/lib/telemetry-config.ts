/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

// ─── Telemetry Configuration ──────────────────────────────────────────────────
// PR-005: Privacy-first telemetry — opt-in only, anonymous metrics only.

export interface TelemetryConfig {
  enabled: boolean;
}

/**
 * Parse RORCA_TELEMETRY env var.
 * Valid values: '0', 'false' (disabled), '1', 'true' (enabled)
 * Default: false (telemetry is OFF by default)
 */
export function parseTelemetryConfig(env: Record<string, string | undefined> = process.env): TelemetryConfig {
  const raw = env.RORCA_TELEMETRY ?? '0';
  const normalized = raw.toLowerCase().trim();
  const enabled = normalized === '1' || normalized === 'true';
  return { enabled };
}

/** Singleton telemetry config — parsed once at module load. */
export const telemetryConfig: TelemetryConfig = parseTelemetryConfig();

export const isTelemetryEnabled = (): boolean => telemetryConfig.enabled;
