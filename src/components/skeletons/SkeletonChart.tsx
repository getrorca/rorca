/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SkeletonChart — chart area placeholder with axis lines and bar/area hints.
 */
interface SkeletonChartProps {
  className?: string;
  /** Chart height (default h-64) */
  height?: string;
}

export function SkeletonChart({ className = '', height = 'h-64' }: SkeletonChartProps) {
  return (
    <div className={`bg-panel border border-border rounded-lg p-4 ${className}`}>
      {/* Chart title */}
      <div className="skeleton-shimmer rounded h-4 w-32 mb-4" />
      {/* Chart area with fake bars */}
      <div className={`relative ${height} flex items-end gap-2`}>
        {/* Y-axis line */}
        <div className="absolute left-0 top-0 bottom-0 w-px bg-border" />
        {/* X-axis line */}
        <div className="absolute left-0 right-0 bottom-0 h-px bg-border" />
        {/* Bar placeholders */}
        {[45, 65, 35, 80, 55, 70, 40, 60, 50, 75, 42, 68].map((h, i) => (
          <div
            key={i}
            className="flex-1 skeleton-shimmer rounded-t"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      {/* X-axis labels */}
      <div className="flex items-center gap-2 mt-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton-shimmer rounded h-2.5 flex-1" />
        ))}
      </div>
    </div>
  );
}
