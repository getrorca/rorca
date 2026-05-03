/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SkeletonColumn — Kanban/board column placeholder.
 * Header bar + N card-shaped grey rectangles, matching board layout.
 */
import { SkeletonCard } from './SkeletonCard';

interface SkeletonColumnProps {
  /** Number of card placeholders (default 3) */
  cards?: number;
  className?: string;
}

export function SkeletonColumn({ cards = 3, className = '' }: SkeletonColumnProps) {
  return (
    <div className={`flex flex-col min-w-[220px] ${className}`}>
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2.5 mb-2">
        <div className="skeleton-shimmer rounded-full h-2 w-2" />
        <div className="skeleton-shimmer rounded h-3.5 w-20" />
        <div className="skeleton-shimmer rounded-full h-4 w-6 ml-auto" />
      </div>
      {/* Cards */}
      <div className="space-y-2 px-1">
        {Array.from({ length: cards }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
