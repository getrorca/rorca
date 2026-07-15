/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export type CapturePolicyMode = "off" | "metadata-only" | "command-summary" | "explicit-transcript-import";

export type RorcaCaptureConfig = {
  enabled: boolean;
  apiBaseUrl: string;
  workspaceId?: string;
  policyMode: CapturePolicyMode;
  queueMaxSize: number;
  memoryCandidateMaxCount: number;
  memoryCandidateTokenCap: number;
};

export const DEFAULT_RORCA_CAPTURE_CONFIG: RorcaCaptureConfig = {
  enabled: true,
  apiBaseUrl: "http://127.0.0.1:3030",
  policyMode: "metadata-only",
  queueMaxSize: 1_000,
  memoryCandidateMaxCount: 8,
  memoryCandidateTokenCap: 1_200,
};

export type ConfigReader = { get<T>(key: string, defaultValue?: T): T | undefined };

export function normalizeRorcaCaptureConfig(reader: ConfigReader): RorcaCaptureConfig {
  const policyMode = normalizePolicyMode(reader.get("policyMode", DEFAULT_RORCA_CAPTURE_CONFIG.policyMode));
  const workspaceId = normalizeOptionalString(reader.get("workspaceId", ""));
  return {
    enabled: reader.get("enabled", DEFAULT_RORCA_CAPTURE_CONFIG.enabled) !== false,
    apiBaseUrl: normalizeApiBaseUrl(reader.get("apiBaseUrl", DEFAULT_RORCA_CAPTURE_CONFIG.apiBaseUrl)),
    ...(workspaceId ? { workspaceId } : {}),
    policyMode,
    queueMaxSize: clampInteger(reader.get("queueMaxSize", DEFAULT_RORCA_CAPTURE_CONFIG.queueMaxSize), 1, 10_000, DEFAULT_RORCA_CAPTURE_CONFIG.queueMaxSize),
    memoryCandidateMaxCount: clampInteger(reader.get("memoryCandidateMaxCount", DEFAULT_RORCA_CAPTURE_CONFIG.memoryCandidateMaxCount), 1, 32, DEFAULT_RORCA_CAPTURE_CONFIG.memoryCandidateMaxCount),
    memoryCandidateTokenCap: clampInteger(reader.get("memoryCandidateTokenCap", DEFAULT_RORCA_CAPTURE_CONFIG.memoryCandidateTokenCap), 100, 8_000, DEFAULT_RORCA_CAPTURE_CONFIG.memoryCandidateTokenCap),
  };
}

export function normalizeApiBaseUrl(value: unknown): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_RORCA_CAPTURE_CONFIG.apiBaseUrl;
  return text.replace(/\/+$/, "");
}

export function normalizePolicyMode(value: unknown): CapturePolicyMode {
  return value === "off" || value === "metadata-only" || value === "command-summary" || value === "explicit-transcript-import"
    ? value
    : DEFAULT_RORCA_CAPTURE_CONFIG.policyMode;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}
