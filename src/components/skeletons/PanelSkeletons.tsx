/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Panel-specific skeleton compositions matching each panel's final layout shape.
 * Uses shimmer animation (not animate-pulse) per ULT-017.
 */
import { SkeletonColumn } from './SkeletonColumn';
import { SkeletonTable } from './SkeletonTable';
import { SkeletonChart } from './SkeletonChart';
import { SkeletonForm } from './SkeletonForm';
import { SkeletonMetricCard } from './SkeletonMetricCard';

/**
 * Board skeleton: 3-5 column outlines with 2-4 card-shaped rectangles each.
 * Matches SpecsPanel board/kanban view.
 */
export function BoardSkeleton() {
  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="shrink-0 px-4 py-3 border-b border-border flex items-center gap-4">
        <div className="skeleton-shimmer rounded h-4 w-14" />
        <div className="skeleton-shimmer rounded h-4 w-12" />
        <div className="skeleton-shimmer rounded h-4 w-16" />
        <div className="flex-1" />
        <div className="skeleton-shimmer rounded-md h-8 w-24" />
      </div>
      {/* Board columns */}
      <div className="flex-1 overflow-hidden">
        <div className="flex gap-4 p-4 h-full overflow-x-auto">
          <SkeletonColumn cards={3} className="flex-1 min-w-[240px]" />
          <SkeletonColumn cards={4} className="flex-1 min-w-[240px]" />
          <SkeletonColumn cards={2} className="flex-1 min-w-[240px]" />
          <SkeletonColumn cards={3} className="flex-1 min-w-[240px]" />
        </div>
      </div>
    </div>
  );
}

/** Lifecycle matrix skeleton: KPI cards, filters, phase headers, and rows. */
export function LifecycleMatrixSkeleton() {
  return (
    <div className="lifecycle-control h-full flex flex-col bg-bg" aria-label="Loading Lifecycle Control" role="status">
      <div className="flex min-h-[72px] shrink-0 items-center gap-3 border-b border-border bg-panel px-4 sm:px-6">
        <span className="text-lg font-semibold text-[var(--text)]">Lifecycle Control</span>
        <div className="flex-1" />
        <div className="lifecycle-skeleton-block h-9 w-32 rounded-md" />
      </div>
      <div className="flex-1 overflow-hidden p-3 sm:p-4 space-y-3">
        <div className="grid min-h-[88px] grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => <SkeletonMetricCard key={index} />)}
        </div>
        <div className="h-[78px] rounded-lg border border-border bg-panel p-2">
          <div className="lifecycle-skeleton-block h-9 w-full rounded-md" />
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-panel">
          <div className="overflow-hidden">
            <div className="lifecycle-skeleton-matrix grid min-w-[1710px] grid-cols-[280px_repeat(11,130px)] gap-px bg-border">
              {Array.from({ length: 12 }).map((_, index) => <div key={`header-${index}`} className="lifecycle-skeleton-block h-10" />)}
              {Array.from({ length: 48 }).map((_, index) => <div key={`cell-${index}`} className="lifecycle-skeleton-block h-16" />)}
            </div>
          </div>
        </div>
      </div>
      <span className="sr-only">Loading metrics, filters, and lifecycle phases.</span>
    </div>
  );
}

/**
 * List skeleton: table header + 8 grey row rectangles with varying widths.
 * Matches SpecsPanel list view / archive table.
 */
export function ListSkeleton() {
  return (
    <div className="h-full flex flex-col">
      {/* Search / filter bar */}
      <div className="shrink-0 px-4 py-3 border-b border-border flex items-center gap-3">
        <div className="skeleton-shimmer rounded-lg h-9 flex-1" />
        <div className="skeleton-shimmer rounded-md h-9 w-20" />
      </div>
      {/* Table */}
      <div className="flex-1 p-4 overflow-y-auto">
        <SkeletonTable rows={8} columns={4} />
      </div>
    </div>
  );
}

/**
 * Analytics skeleton: 6 metric card outlines (top row) + chart area rectangle (main area).
 * Matches AnalyticsPanel layout.
 */
export function AnalyticsSkeleton() {
  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="shrink-0 px-4 py-3 border-b border-border flex items-center gap-4">
        {['w-16', 'w-12', 'w-20', 'w-14'].map((w, i) => (
          <div key={i} className={`skeleton-shimmer rounded h-4 ${w}`} />
        ))}
      </div>
      <div className="flex-1 p-4 space-y-4 overflow-y-auto">
        {/* Metric cards — 6 in a 3x2 grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonMetricCard key={i} />
          ))}
        </div>
        {/* Chart area */}
        <SkeletonChart height="h-64" />
      </div>
    </div>
  );
}

/**
 * Direction skeleton: 3 textarea outlines stacked vertically with label bars.
 * Matches DirectionTabbedPanel layout.
 */
export function DirectionSkeleton() {
  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="shrink-0 px-4 py-3 border-b border-border flex items-center gap-4">
        <div className="skeleton-shimmer rounded h-4 w-20" />
        <div className="skeleton-shimmer rounded h-4 w-14" />
        <div className="skeleton-shimmer rounded h-4 w-16" />
      </div>
      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {/* 3 textarea sections */}
        {['L1 — Global', 'L2 — Domain', 'L3 — Project'].map((_, i) => (
          <div key={i} className="space-y-2">
            {/* Label bar */}
            <div className="flex items-center gap-2">
              <div className="skeleton-shimmer rounded-full h-2 w-2" />
              <div
                className="skeleton-shimmer rounded h-3.5"
                style={{ width: `${80 + i * 20}px` }}
              />
            </div>
            {/* Textarea outline */}
            <div className="skeleton-shimmer rounded-lg h-28 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Run View skeleton: terminal area rectangle (60%) + story list skeleton (40%).
 * Matches RunViewPanel split layout.
 */
export function RunViewSkeleton() {
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-border bg-panel flex items-center gap-3">
        <div className="skeleton-shimmer rounded-lg w-6 h-6" />
        <div className="skeleton-shimmer rounded h-4 w-32" />
        <div className="skeleton-shimmer rounded-full h-5 w-16" />
        <div className="flex-1" />
        <div className="skeleton-shimmer rounded h-3 w-20" />
      </div>
      {/* Tab bar */}
      <div className="shrink-0 px-4 border-b border-border bg-panel flex items-center gap-3 py-2">
        <div className="skeleton-shimmer rounded h-4 w-16" />
        <div className="skeleton-shimmer rounded h-4 w-14" />
        <div className="skeleton-shimmer rounded h-4 w-16" />
        <div className="skeleton-shimmer rounded h-4 w-14" />
      </div>
      {/* Content split */}
      <div className="flex-1 flex min-h-0">
        {/* Terminal area — 60% */}
        <div className="flex-[3] bg-terminal-bg p-4 space-y-2.5 overflow-hidden">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="skeleton-shimmer rounded h-3.5"
              style={{
                width: `${30 + Math.sin(i * 1.7) * 25 + (i % 3) * 10}%`,
                opacity: 0.7,
              }}
            />
          ))}
        </div>
        {/* Story list — 40% */}
        <div className="flex-[2] border-l border-border p-3 space-y-2 overflow-hidden">
          <div className="skeleton-shimmer rounded h-3.5 w-24 mb-3" />
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 py-1.5">
              <div className="skeleton-shimmer rounded-full h-4 w-4 shrink-0" />
              <div
                className="skeleton-shimmer rounded h-3"
                style={{ width: `${50 + (i % 4) * 12}%` }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Settings skeleton: form field outlines matching settings tab content.
 */
export function SettingsFormSkeleton() {
  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="shrink-0 px-6 pt-4 flex items-center gap-4 border-b border-border pb-3">
        {['w-20', 'w-16', 'w-14', 'w-18', 'w-16'].map((w, i) => (
          <div key={i} className={`skeleton-shimmer rounded h-4 ${w}`} />
        ))}
      </div>
      {/* Form content */}
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-xl space-y-6">
          {/* Section title */}
          <div className="skeleton-shimmer rounded h-5 w-40" />
          <SkeletonForm fields={3} />
          {/* Divider */}
          <div className="border-t border-border" />
          {/* Second section */}
          <div className="skeleton-shimmer rounded h-5 w-36" />
          <SkeletonForm fields={2} />
        </div>
      </div>
    </div>
  );
}
