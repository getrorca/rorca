/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Presentation helpers for Mission OS surfaces. These format server-authored
 * values only; they never derive state that the backend did not provide.
 */

const RELATIVE_STEPS: Array<{ limitSeconds: number; divisor: number; unit: string }> = [
  { limitSeconds: 90, divisor: 1, unit: 's' },
  { limitSeconds: 90 * 60, divisor: 60, unit: 'min' },
  { limitSeconds: 36 * 3600, divisor: 3600, unit: 'h' },
  { limitSeconds: 10 * 86_400, divisor: 86_400, unit: 'd' },
];

/** Compact age string for an ISO timestamp: `just now`, `5 min ago`, `3 h ago`. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown time';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return 'in the future';
  if (seconds < 15) return 'just now';
  for (const step of RELATIVE_STEPS) {
    if (seconds < step.limitSeconds) {
      const value = Math.max(1, Math.round(seconds / step.divisor));
      return `${value} ${step.unit} ago`;
    }
  }
  return new Date(then).toLocaleDateString();
}

/** Absolute timestamp for tooltips/aria: locale date + time. */
export function formatAbsoluteTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown time';
  return new Date(then).toLocaleString();
}

/** USD cost with cents; null (backend had no figure) renders as unavailable. */
export function formatUsd(value: number | null): string {
  if (value === null) return 'unavailable';
  return `$${value.toFixed(2)}`;
}

/** Token counts in compact form; null stays honestly unavailable. */
export function formatTokenCount(value: number | null): string {
  if (value === null) return 'unavailable';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

/** Whole seconds → `1h 12m`, `4m 20s`; null stays unavailable. */
export function formatElapsedSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'unavailable';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** Elapsed time between two ISO timestamps (end defaults to now). */
export function elapsedBetween(startIso: string, endIso?: string | null): number | null {
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return (end - start) / 1000;
}
