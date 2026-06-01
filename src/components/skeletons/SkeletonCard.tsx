/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SkeletonCard — card-shaped shimmer placeholder.
 * Matches spec card / run card dimensions with title line, meta, and action row.
 */
interface SkeletonCardProps {
  className?: string;
  /** Show action button row at bottom */
  showActions?: boolean;
}

export function SkeletonCard({ className = '', showActions = false }: SkeletonCardProps) {
  return (
    <div className={`p-4 bg-panel border border-border rounded-lg space-y-2.5 ${className}`}>
      {/* Title line */}
      <div className="skeleton-shimmer rounded h-4 w-3/4" />
      {/* Meta line */}
      <div className="skeleton-shimmer rounded h-3 w-1/2" />
      {/* Description lines */}
      <div className="space-y-1.5 pt-1">
        <div className="skeleton-shimmer rounded h-2.5 w-full" />
        <div className="skeleton-shimmer rounded h-2.5 w-5/6" />
      </div>
      {showActions && (
        <div className="flex items-center gap-2 pt-1">
          <div className="skeleton-shimmer rounded-md h-6 w-20" />
          <div className="skeleton-shimmer rounded-md h-6 w-16" />
        </div>
      )}
    </div>
  );
}
