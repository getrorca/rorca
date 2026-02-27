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
      <div className="flex-1 bg-[#1e1e1e] p-4 space-y-2.5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="animate-pulse bg-[#333] rounded h-3.5"
            style={{ width: `${45 + Math.sin(i * 1.7) * 30}%` }}
          />
        ))}
      </div>
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
