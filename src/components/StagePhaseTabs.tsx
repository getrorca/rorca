/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * StagePhaseTabs — the contextual breakdown for a multi-part lifecycle stage.
 *
 * The 7-stage presentation keeps the stage rail always visible. Only stages
 * with multiple canonical controls render a tablist here; singleton labels
 * such as Intake or Implementation add no navigation value and stay hidden.
 * At most three controls are visible at once.
 */

import { useEffect, useRef, useState } from 'react';
import type { LifecyclePhaseId, LifecycleMissionStage } from '../types/lifecycle';
import { stageDisplayName, stagePhaseDescriptors } from '../lib/lifecycle-stages';

interface StagePhaseTabsProps {
  stageId: LifecycleMissionStage;
  selectedPhaseId: LifecyclePhaseId | null;
  /** Phase to receive initial roving focus when the tabs mount. */
  initialFocusPhaseId?: LifecyclePhaseId | null;
  onSelectPhase: (phaseId: LifecyclePhaseId) => void;
}

export default function StagePhaseTabs({
  stageId,
  selectedPhaseId,
  initialFocusPhaseId = null,
  onSelectPhase,
}: StagePhaseTabsProps) {
  const phases = stagePhaseDescriptors(stageId);
  const buttonRefs = useRef(new Map<LifecyclePhaseId, HTMLButtonElement>());
  const [rovingPhaseId, setRovingPhaseId] = useState<LifecyclePhaseId>(
    selectedPhaseId ?? initialFocusPhaseId ?? phases[0]?.id ?? 'planning',
  );

  useEffect(() => {
    setRovingPhaseId((current) => (phases.some((phase) => phase.id === current) ? current : phases[0]?.id ?? 'planning'));
  }, [phases]);

  useEffect(() => {
    if (selectedPhaseId && phases.some((phase) => phase.id === selectedPhaseId)) {
      setRovingPhaseId(selectedPhaseId);
    }
  }, [selectedPhaseId, phases]);

  if (phases.length <= 1) return null;

  const moveFocus = (currentPhaseId: LifecyclePhaseId, key: string): boolean => {
    const currentIndex = phases.findIndex((phase) => phase.id === currentPhaseId);
    let nextIndex = currentIndex;
    if (key === 'ArrowRight' || key === 'ArrowDown') nextIndex = (currentIndex + 1) % phases.length;
    else if (key === 'ArrowLeft' || key === 'ArrowUp') nextIndex = (currentIndex - 1 + phases.length) % phases.length;
    else if (key === 'Home') nextIndex = 0;
    else if (key === 'End') nextIndex = phases.length - 1;
    else return false;
    const next = phases[nextIndex];
    if (!next) return false;
    setRovingPhaseId(next.id);
    buttonRefs.current.get(next.id)?.focus();
    return true;
  };

  return (
    <div
      className="lifecycle-stage-tabs"
      role="tablist"
      aria-label={`${stageDisplayName(stageId)} phases`}
      data-stage={stageId}
    >
      {phases.map((phase) => (
        <button
          key={phase.id}
          ref={(node) => {
            if (node) buttonRefs.current.set(phase.id, node);
            else buttonRefs.current.delete(phase.id);
          }}
          type="button"
          role="tab"
          aria-selected={phase.id === selectedPhaseId}
          tabIndex={phase.id === rovingPhaseId ? 0 : -1}
          data-phase={phase.id}
          data-lifecycle-phase-tab="true"
          onFocus={() => setRovingPhaseId(phase.id)}
          onKeyDown={(event) => {
            if (moveFocus(phase.id, event.key)) event.preventDefault();
          }}
          onClick={() => onSelectPhase(phase.id)}
          className="lifecycle-stage-tab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {phase.displayName}
        </button>
      ))}
    </div>
  );
}
