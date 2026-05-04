/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * SkeletonFadeWrapper — wraps real content with a fade-in transition.
 * When `loading` is true, renders the skeleton. When false, fades in the children
 * over 200ms (opacity transition) with no white flash.
 */
import { type ReactNode } from 'react';

interface SkeletonFadeWrapperProps {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}

export function SkeletonFadeWrapper({ loading, skeleton, children }: SkeletonFadeWrapperProps) {
  return (
    <div className="h-full relative">
      {/* Skeleton layer — rendered on top while loading */}
      <div
        className="absolute inset-0 skeleton-fade-out z-10"
        style={{ opacity: loading ? 1 : 0, pointerEvents: loading ? 'auto' : 'none' }}
      >
        {skeleton}
      </div>
      {/* Content layer — always mounted, becomes visible when loading=false */}
      <div
        className="h-full skeleton-fade-out"
        style={{ opacity: loading ? 0 : 1 }}
      >
        {children}
      </div>
    </div>
  );
}
