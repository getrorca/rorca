/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Skeleton loading primitives using Tailwind animate-pulse.
 * All shapes match the exact dimensions of the real content they replace.
 */

interface SkeletonProps {
  className?: string;
}

/** Generic pulsing block — pass w/h/rounded via className */
export function SkeletonBlock({ className = '' }: SkeletonProps) {
  return <div className={`animate-pulse bg-border/50 rounded ${className}`} />;
}

/** Text line — height ~14px (text-sm equivalent) */
export function SkeletonLine({ className = '' }: SkeletonProps) {
  return <div className={`animate-pulse bg-border/50 rounded h-3.5 ${className}`} />;
}

/** Small badge/chip shape */
export function SkeletonBadge({ className = '' }: SkeletonProps) {
  return <div className={`animate-pulse bg-border/50 rounded-full h-5 ${className}`} />;
}

/** Circle (avatar, status dot, icon placeholder) */
export function SkeletonCircle({ className = '' }: SkeletonProps) {
  return <div className={`animate-pulse bg-border/50 rounded-full ${className}`} />;
}

/* ─── Composite skeletons matching real panel layouts ─── */

/** Matches ActiveRunCard layout: header row, spec name, progress bar, footer */
export function HubActiveRunSkeleton() {
  return (
    <div className="p-4 bg-panel border border-l-4 border-border rounded-lg space-y-3">
      {/* Header: status dot + label + run ID */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SkeletonCircle className="w-2 h-2" />
          <SkeletonLine className="w-16" />
          <SkeletonLine className="w-8" />
        </div>
        <SkeletonBlock className="w-4 h-4" />
      </div>
      {/* Spec name */}
      <SkeletonLine className="w-48" />
      {/* Current story */}
      <SkeletonLine className="w-36 h-3" />
      {/* Progress bar */}
      <SkeletonBlock className="w-full h-1.5 rounded-full" />
      {/* Footer: time + counts */}
      <div className="flex items-center justify-between">
        <SkeletonLine className="w-24 h-3" />
        <SkeletonLine className="w-16 h-3" />
      </div>
    </div>
  );
}

/** Matches PendingReviewCard layout: title, meta, story previews, actions */
export function HubPendingReviewSkeleton() {
  return (
    <div className="p-4 bg-panel border border-border rounded-lg space-y-2">
      {/* Title + chevron */}
      <div className="flex items-start justify-between gap-2">
        <SkeletonLine className="w-44 h-4" />
        <SkeletonBlock className="w-4 h-4 shrink-0" />
      </div>
      {/* Meta: story count + timestamp */}
      <div className="flex items-center gap-2">
        <SkeletonLine className="w-16 h-3" />
        <SkeletonLine className="w-20 h-3" />
      </div>
      {/* Story title previews */}
      <div className="pl-2 border-l-2 border-border space-y-1">
        <SkeletonLine className="w-32 h-2.5" />
        <SkeletonLine className="w-28 h-2.5" />
      </div>
      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-1">
        <SkeletonBadge className="w-20 h-6 rounded-md" />
        <SkeletonBadge className="w-16 h-6 rounded-md" />
      </div>
    </div>
  );
}

/** Matches RecentRunRow layout: dot + name + id + badge + time + duration */
export function HubRecentRunSkeleton() {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <SkeletonCircle className="w-1.5 h-1.5 shrink-0" />
          <SkeletonLine className="w-32" />
          <SkeletonLine className="w-6 h-3" />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <SkeletonBadge className="w-12 h-4 rounded" />
          <SkeletonLine className="w-14 h-3" />
          <SkeletonLine className="w-10 h-3" />
        </div>
      </div>
    </div>
  );
}

/** 3 skeleton cards for the Hub loading state */
export function HubSkeleton() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-8">
        {/* Active run skeleton */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <SkeletonCircle className="w-4 h-4" />
            <SkeletonLine className="w-20 h-3.5" />
          </div>
          <HubActiveRunSkeleton />
        </section>

        {/* Pending reviews skeleton */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <SkeletonCircle className="w-4 h-4" />
            <SkeletonLine className="w-28 h-3.5" />
          </div>
          <HubPendingReviewSkeleton />
        </section>

        {/* Recent runs skeleton */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <SkeletonCircle className="w-4 h-4" />
            <SkeletonLine className="w-24 h-3.5" />
          </div>
          <div className="bg-panel border border-border rounded-lg divide-y divide-border">
            <HubRecentRunSkeleton />
            <HubRecentRunSkeleton />
            <HubRecentRunSkeleton />
          </div>
        </section>
      </div>
    </div>
  );
}

/** 10 grey bars matching terminal line height for RunView loading */
export function RunViewTerminalSkeleton() {
  return (
    <div className="h-full flex flex-col">
      {/* Header skeleton */}
      <div className="shrink-0 px-4 py-3 border-b border-border bg-panel flex items-center gap-3">
        <SkeletonBlock className="w-6 h-6 rounded-lg" />
        <SkeletonLine className="w-24" />
        <SkeletonBadge className="w-16 h-5 rounded" />
        <div className="flex-1" />
        <SkeletonLine className="w-20 h-3" />
      </div>
      {/* Tab bar skeleton */}
      <div className="shrink-0 px-4 border-b border-border bg-panel flex items-center gap-3 py-2">
        <SkeletonLine className="w-16 h-4" />
        <SkeletonLine className="w-14 h-4" />
        <SkeletonLine className="w-16 h-4" />
        <SkeletonLine className="w-14 h-4" />
      </div>
      {/* Terminal lines */}
      <div className="flex-1 bg-terminal-bg p-4 space-y-2.5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="animate-pulse bg-terminal-line rounded h-3.5"
            style={{ width: `${45 + Math.sin(i * 1.7) * 30}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Forge panel skeleton: textarea + sidebar */
export function ForgeSkeleton() {
  return (
    <div className="h-full flex">
      {/* Main area */}
      <div className="flex-1 flex flex-col p-6 space-y-4">
        <SkeletonLine className="w-32 h-5" />
        <SkeletonBlock className="w-full h-32 rounded-lg" />
        <div className="flex items-center gap-2">
          <SkeletonBadge className="w-24 h-8 rounded-md" />
          <SkeletonBadge className="w-20 h-8 rounded-md" />
        </div>
        <div className="space-y-2 pt-4">
          <SkeletonLine className="w-24 h-3.5" />
          <SkeletonBlock className="w-full h-20 rounded-lg" />
        </div>
      </div>
      {/* Sidebar */}
      <div className="w-72 border-l border-border p-4 space-y-3 hidden lg:block">
        <SkeletonLine className="w-28 h-3.5" />
        {[0, 1, 2].map((i) => (
          <SkeletonBlock key={i} className="w-full h-12 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

/** Settings panel skeleton: tab bar + content */
export function SettingsSkeleton() {
  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div className="shrink-0 px-6 pt-4 flex items-center gap-4 border-b border-border pb-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonLine key={i} className="w-16 h-4" />
        ))}
      </div>
      {/* Content */}
      <div className="flex-1 p-6 space-y-4 overflow-y-auto">
        <SkeletonLine className="w-40 h-5" />
        <SkeletonBlock className="w-full h-24 rounded-lg" />
        <SkeletonLine className="w-32 h-5" />
        <SkeletonBlock className="w-full h-24 rounded-lg" />
        <SkeletonLine className="w-36 h-5" />
        <SkeletonBlock className="w-full h-16 rounded-lg" />
      </div>
    </div>
  );
}

/** Generic panel skeleton: title + content blocks */
export function GenericPanelSkeleton() {
  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <SkeletonLine className="w-40 h-5" />
      <SkeletonBlock className="w-full h-32 rounded-lg" />
      <div className="space-y-2">
        <SkeletonLine className="w-full h-3.5" />
        <SkeletonLine className="w-3/4 h-3.5" />
        <SkeletonLine className="w-5/6 h-3.5" />
      </div>
      <SkeletonBlock className="w-full h-48 rounded-lg" />
    </div>
  );
}

/** Archive panel skeleton: search bar + list of spec cards */
export function ArchiveSkeleton() {
  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <div className="flex items-center gap-3">
        <SkeletonBlock className="flex-1 h-9 rounded-lg" />
        <SkeletonBadge className="w-20 h-9 rounded-md" />
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="p-4 bg-panel border border-border rounded-lg space-y-2">
          <div className="flex items-center justify-between">
            <SkeletonLine className="w-48 h-4" />
            <SkeletonBadge className="w-16 h-5 rounded" />
          </div>
          <SkeletonLine className="w-32 h-3" />
          <div className="flex items-center gap-2 pt-1">
            <SkeletonBadge className="w-20 h-6 rounded-md" />
            <SkeletonBadge className="w-16 h-6 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Pipeline/Runs panel skeleton: tab bar + run list */
export function PipelineSkeleton() {
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-4 border-b border-border flex items-center gap-3 py-3">
        <SkeletonLine className="w-20 h-4" />
        <SkeletonLine className="w-16 h-4" />
        <SkeletonLine className="w-18 h-4" />
      </div>
      <div className="flex-1 p-4 space-y-3 overflow-y-auto">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="p-3 bg-panel border border-border rounded-lg flex items-center gap-3">
            <SkeletonCircle className="w-2.5 h-2.5 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <SkeletonLine className="w-40" />
              <SkeletonLine className="w-24 h-3" />
            </div>
            <SkeletonBadge className="w-14 h-5 rounded" />
            <SkeletonLine className="w-16 h-3" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Worktrees panel skeleton */
export function WorktreesSkeleton() {
  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <SkeletonLine className="w-32 h-5" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="p-4 bg-panel border border-border rounded-lg space-y-2">
          <div className="flex items-center justify-between">
            <SkeletonLine className="w-36 h-4" />
            <SkeletonBadge className="w-16 h-6 rounded-md" />
          </div>
          <SkeletonLine className="w-48 h-3" />
        </div>
      ))}
    </div>
  );
}

/** Compare runs panel skeleton */
export function CompareSkeleton() {
  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <SkeletonLine className="w-40 h-5" />
      <div className="grid grid-cols-2 gap-4">
        <SkeletonBlock className="h-40 rounded-lg" />
        <SkeletonBlock className="h-40 rounded-lg" />
      </div>
      <SkeletonBlock className="w-full h-48 rounded-lg" />
    </div>
  );
}

/** Marketplace panel skeleton: search + grid of template cards */
export function MarketplaceSkeleton() {
  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <SkeletonBlock className="w-full h-9 rounded-lg" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="p-4 bg-panel border border-border rounded-lg space-y-2">
            <SkeletonLine className="w-32 h-4" />
            <SkeletonLine className="w-full h-3" />
            <SkeletonLine className="w-3/4 h-3" />
            <div className="flex items-center gap-2 pt-1">
              <SkeletonBadge className="w-16 h-5 rounded" />
              <SkeletonBadge className="w-12 h-5 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Direction stack panel skeleton: layer list */
export function DirectionStackSkeleton() {
  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <SkeletonLine className="w-36 h-5" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="p-4 bg-panel border border-border rounded-lg space-y-2">
          <div className="flex items-center gap-2">
            <SkeletonCircle className="w-2 h-2" />
            <SkeletonLine className="w-20 h-4" />
          </div>
          <SkeletonLine className="w-full h-3" />
          <SkeletonLine className="w-2/3 h-3" />
        </div>
      ))}
    </div>
  );
}

/** Memory ledger panel skeleton */
export function MemorySkeleton() {
  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <SkeletonLine className="w-32 h-5" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="p-4 bg-panel border border-border rounded-lg space-y-2">
          <div className="flex items-center gap-2">
            <SkeletonBadge className="w-16 h-5 rounded" />
            <SkeletonLine className="w-36 h-4" />
          </div>
          <SkeletonLine className="w-full h-3" />
          <SkeletonLine className="w-3/4 h-3" />
        </div>
      ))}
    </div>
  );
}

/** Matches DirectionPreviewSidebar content: 3 layer rows (rendered inside existing container) */
export function DirectionSidebarSkeleton() {
  return (
    <div className="py-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border-b border-border/50 last:border-b-0">
          <div className="flex items-center justify-between px-4 py-2.5">
            <div className="flex items-center gap-2">
              <SkeletonCircle className="w-1.5 h-1.5" />
              <SkeletonLine className="w-20 h-3" />
            </div>
            <SkeletonBlock className="w-3 h-3" />
          </div>
          {/* Description line */}
          <div className="px-4 pb-3">
            <SkeletonLine className="w-40 h-2.5" />
          </div>
          </div>
        ))}
    </div>
  );
}
