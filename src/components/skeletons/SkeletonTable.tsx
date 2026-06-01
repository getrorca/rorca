/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SkeletonTable — table/list skeleton with header row + N data rows.
 * Rows have varying widths to look natural.
 */
interface SkeletonTableProps {
  /** Number of data rows (default 8) */
  rows?: number;
  /** Number of columns (default 4) */
  columns?: number;
  className?: string;
}

const ROW_WIDTHS = ['w-full', 'w-5/6', 'w-4/5', 'w-11/12', 'w-3/4', 'w-full', 'w-5/6', 'w-4/5'];

export function SkeletonTable({ rows = 8, columns = 4, className = '' }: SkeletonTableProps) {
  return (
    <div className={`bg-panel border border-border rounded-lg overflow-hidden ${className}`}>
      {/* Header row */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-border bg-surface-200/50">
        {Array.from({ length: columns }).map((_, i) => (
          <div
            key={i}
            className="skeleton-shimmer rounded h-3"
            style={{ width: `${i === 0 ? 30 : 15 + (i * 5)}%` }}
          />
        ))}
      </div>
      {/* Data rows */}
      {Array.from({ length: rows }).map((_, row) => (
        <div
          key={row}
          className="flex items-center gap-4 px-4 py-3 border-b border-border last:border-b-0"
        >
          {Array.from({ length: columns }).map((_, col) => (
            <div
              key={col}
              className={`skeleton-shimmer rounded h-3 ${col === 0 ? ROW_WIDTHS[row % ROW_WIDTHS.length] : ''}`}
              style={{ width: col === 0 ? undefined : `${10 + (col * 8) + (row % 3) * 4}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
