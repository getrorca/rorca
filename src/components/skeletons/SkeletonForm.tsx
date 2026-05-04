/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SkeletonForm — form field outlines (label + input pairs).
 */
interface SkeletonFormProps {
  /** Number of fields (default 4) */
  fields?: number;
  className?: string;
}

export function SkeletonForm({ fields = 4, className = '' }: SkeletonFormProps) {
  return (
    <div className={`space-y-5 ${className}`}>
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          {/* Label */}
          <div
            className="skeleton-shimmer rounded h-3"
            style={{ width: `${60 + (i * 10) % 40}px` }}
          />
          {/* Input field */}
          <div className="skeleton-shimmer rounded-md h-9 w-full" />
        </div>
      ))}
      {/* Submit button */}
      <div className="skeleton-shimmer rounded-md h-9 w-28 mt-2" />
    </div>
  );
}
