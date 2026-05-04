/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SkeletonMetricCard — analytics metric card outline (label + big number + trend).
 */
interface SkeletonMetricCardProps {
  className?: string;
}

export function SkeletonMetricCard({ className = '' }: SkeletonMetricCardProps) {
  return (
    <div className={`p-4 bg-panel border border-border rounded-lg space-y-2 ${className}`}>
      {/* Label */}
      <div className="skeleton-shimmer rounded h-3 w-20" />
      {/* Big number */}
      <div className="skeleton-shimmer rounded h-7 w-24" />
      {/* Trend line */}
      <div className="flex items-center gap-1.5">
        <div className="skeleton-shimmer rounded h-3 w-10" />
        <div className="skeleton-shimmer rounded h-3 w-16" />
      </div>
    </div>
  );
}
