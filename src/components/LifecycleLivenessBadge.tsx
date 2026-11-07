/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { LifecycleLiveness, LifecycleLivenessState } from '../types/lifecycle';

/**
 * Compact liveness indicator: an animated (reduced-motion safe) dot plus a
 * short operator label. Replaces the former "Run liveness is unknown…" prose.
 */
export const LIFECYCLE_LIVENESS_LABELS: Record<LifecycleLivenessState, string> = {
  active: 'Run active',
  quiet_active: 'Run quiet',
  stalled: 'Run stalled',
  blocked: 'Run blocked',
  completed: 'Run done',
  unknown: 'Run unknown',
};

interface LifecycleLivenessBadgeProps {
  liveness: LifecycleLiveness | null;
}

export default function LifecycleLivenessBadge({ liveness }: LifecycleLivenessBadgeProps) {
  if (!liveness) {
    return (
      <span className="lifecycle-liveness" data-state="none">
        <span className="lifecycle-liveness__dot" aria-hidden="true" />
        <span className="lifecycle-liveness__label">No active run</span>
      </span>
    );
  }
  const label = LIFECYCLE_LIVENESS_LABELS[liveness.state];
  const blocker = liveness.blocker;
  const title = blocker
    ? `${label} — ${blocker.summary}`
    : `${label} · ${Math.round(liveness.confidence * 100)}% confidence`;
  return (
    <span className="lifecycle-liveness" data-state={liveness.state} title={title}>
      <span className="lifecycle-liveness__dot" aria-hidden="true" />
      <span className="lifecycle-liveness__label">{label}</span>
    </span>
  );
}
