/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Database, Network } from 'lucide-react';
import type { DatabaseCapability } from '../contexts/CapabilitiesContext';
import type { GraphRuntimeDescriptor } from '../types/spec-relevance-graph';

type GraphMode = DatabaseCapability['graphMode'];
type DbMode = DatabaseCapability['dbMode'];

export function graphModeLabel(graphMode: GraphMode): string {
  if (graphMode === 'full') return 'Full Graph';
  if (graphMode === 'lite') return 'Graph Lite';
  return 'Graph Disabled';
}

export function dbModeLabel(dbMode: DbMode): string {
  if (dbMode === 'native') return 'Local Postgres';
  if (dbMode === 'docker') return 'Docker Postgres';
  return 'BYOP Postgres';
}

function defaultGraphModeMessage(graphMode: GraphMode): string {
  if (graphMode === 'lite') {
    return 'Rorca is still showing useful semantic and relational fallback data, but Apache AGE graph paths are unavailable right now.';
  }
  return 'The active database connection is unavailable, so AGE-backed graph views are paused until PostgreSQL is reachable again.';
}

function fullGraphRecoveryHint(dbMode?: DbMode | null): string {
  if (dbMode === 'docker') {
    return 'To get Full Graph back, rerun `rorca db start` so Docker Postgres comes up with Apache AGE enabled.';
  }
  if (dbMode === 'native') {
    return 'To get Full Graph back, install Apache AGE locally or switch to Docker Postgres with `rorca db start`.';
  }
  if (dbMode === 'byop') {
    return 'To get Full Graph back, install Apache AGE on your current Postgres instance or switch to local or Docker Postgres with AGE.';
  }
  return 'To get Full Graph back, switch to local or Docker Postgres with Apache AGE, or install Apache AGE on the current Postgres instance.';
}

function defaultGraphModeHint(graphMode: GraphMode, dbMode?: DbMode | null): string {
  if (graphMode === 'lite') return fullGraphRecoveryHint(dbMode);
  return `Reconnect the database first. ${fullGraphRecoveryHint(dbMode)}`;
}

function noticeTone(graphMode: GraphMode) {
  if (graphMode === 'lite') {
    return {
      container: 'border-warning/30 bg-warning/10',
      badge: 'border-warning/30 bg-warning/15 text-warning',
      icon: 'text-warning',
      secondary: 'text-warning/80',
    };
  }

  return {
    container: 'border-border bg-surface-200/60',
    badge: 'border-border bg-bg text-muted',
    icon: 'text-muted',
    secondary: 'text-muted',
  };
}

function noticeIcon(graphMode: GraphMode) {
  if (graphMode === 'lite') return Network;
  return Database;
}

export interface GraphCapabilityNoticeProps {
  graphMode: GraphMode;
  message?: string | null;
  hint?: string | null;
  dbMode?: DbMode | null;
  title?: string;
  compact?: boolean;
  className?: string;
}

export function GraphCapabilityNotice({
  graphMode,
  message,
  hint,
  dbMode,
  title,
  compact = false,
  className = '',
}: GraphCapabilityNoticeProps) {
  if (graphMode === 'full') return null;

  const tone = noticeTone(graphMode);
  const Icon = noticeIcon(graphMode);
  const resolvedTitle = title ?? (graphMode === 'lite'
    ? 'Graph Lite is active'
    : 'Graph views are temporarily unavailable');
  const resolvedMessage = message ?? defaultGraphModeMessage(graphMode);
  const resolvedHint = hint ?? defaultGraphModeHint(graphMode, dbMode);

  return (
    <div
      role="status"
      className={`rounded-lg border ${compact ? 'px-3 py-2' : 'px-4 py-3'} ${tone.container} ${className}`.trim()}
    >
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 shrink-0 ${tone.icon}`}>
          <Icon size={16} />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone.badge}`}>
              {graphModeLabel(graphMode)}
            </span>
            <p className="text-sm font-medium text-[var(--text)]">{resolvedTitle}</p>
          </div>
          <p className={`text-xs ${tone.secondary}`}>{resolvedMessage}</p>
          {resolvedHint ? <p className="text-[11px] text-muted">{resolvedHint}</p> : null}
        </div>
      </div>
    </div>
  );
}

export function runtimeToNoticeProps(
  runtime: GraphRuntimeDescriptor | null | undefined,
  dbMode?: DbMode | null,
): GraphCapabilityNoticeProps | null {
  if (!runtime || runtime.graphMode === 'full') return null;
  return {
    graphMode: runtime.graphMode,
    message: runtime.message,
    hint: runtime.hint,
    dbMode,
  };
}

