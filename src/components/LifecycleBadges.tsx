/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Clock3,
  GitBranch,
  PackageCheck,
  PackageOpen,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';
import type {
  LifecycleAssuranceProjection,
  LifecycleDependencyStatus,
  LifecycleExecutionProjection,
  LifecycleExecutionStatus,
  LifecyclePhaseCell,
  LifecyclePortfolioItem,
  LifecycleReadinessProjection,
  LifecycleRisk,
} from '../types/lifecycle';
import { LIFECYCLE_STATUS_LABELS, LIFECYCLE_STATUS_TONES, LifecycleStatusIcon } from '../panels/LifecycleCell';

/** Status pill: icon + text on a semantic tone. Status is never color-only. */
export function LifecycleStatusBadge({ status, label }: { status: LifecyclePhaseCell['status']; label?: string }) {
  return (
    <span className="lifecycle-badge" data-tone={LIFECYCLE_STATUS_TONES[status]} data-status={status}>
      <LifecycleStatusIcon status={status} size={13} />
      <span>{label ?? LIFECYCLE_STATUS_LABELS[status]}</span>
    </span>
  );
}

const RISK_TONES = { low: 'risk-low', medium: 'risk-medium', high: 'risk-high', critical: 'risk-critical' } as const;

/** Risk pill: distinct tone per risk level, critical always carries an icon. */
export function LifecycleRiskBadge({ risk }: { risk: LifecycleRisk | null }) {
  if (!risk) return <span className="lifecycle-badge" data-tone="stale"><ShieldQuestion size={13} aria-hidden="true" /><span>Risk unassessed</span></span>;
  const label = `${risk.charAt(0).toUpperCase()}${risk.slice(1)} risk`;
  return (
    <span className="lifecycle-badge" data-tone={RISK_TONES[risk]} data-risk={risk}>
      {risk === 'critical' || risk === 'high' ? <ShieldAlert size={13} aria-hidden="true" /> : null}
      <span>{label}</span>
    </span>
  );
}

type DeliveryStatus = LifecyclePortfolioItem['delivery']['status'];
type Assurance = LifecyclePortfolioItem['assurance'] | LifecycleAssuranceProjection;

const DELIVERY_PRESENTATION: Record<DeliveryStatus, { label: string; tone: string }> = {
  completed: { label: 'Delivery completed', tone: 'passed' },
  operator_attested: { label: 'Delivery attested', tone: 'passed' },
  in_progress: { label: 'Delivery in progress', tone: 'progress' },
  failed: { label: 'Delivery failed', tone: 'blocked' },
  superseded: { label: 'Delivery superseded', tone: 'stale' },
  unknown: { label: 'Delivery unknown', tone: 'stale' },
};

const ASSURANCE_PRESENTATION: Record<Assurance['status'], { label: string; tone: string }> = {
  complete: { label: 'Assurance complete', tone: 'passed' },
  partial: { label: 'Assurance partial', tone: 'approval' },
  blocked: { label: 'Assurance blocked', tone: 'blocked' },
  stale: { label: 'Assurance stale', tone: 'stale' },
  not_evaluated: { label: 'Assurance not evaluated', tone: 'stale' },
};

const EXECUTION_PRESENTATION: Record<LifecycleExecutionStatus, { label: string; tone: string }> = {
  not_started: { label: 'Execution not started', tone: 'muted' },
  blocked: { label: 'Execution blocked', tone: 'blocked' },
  ready: { label: 'Execution ready', tone: 'progress' },
  queued: { label: 'Execution queued', tone: 'progress' },
  running: { label: 'Execution running', tone: 'progress' },
  completed: { label: 'Execution completed', tone: 'passed' },
  failed: { label: 'Execution failed', tone: 'blocked' },
};
type LifecycleStoryProgress = {
  passed: number;
  total: number;
  runId?: number | string | null;
};


export function LifecycleExecutionBadge({
  execution,
  storyProgress,
}: {
  execution?: LifecycleExecutionProjection;
  storyProgress?: LifecycleStoryProgress;
}) {
  if (!execution) {
    return <span className="lifecycle-badge" data-tone="muted"><Circle size={13} aria-hidden="true" /><span>Execution unknown</span></span>;
  }
  const presentation = EXECUTION_PRESENTATION[execution.status];
  const Icon = execution.status === 'completed'
    ? CheckCircle2
    : execution.status === 'failed' || execution.status === 'blocked'
      ? AlertTriangle
      : execution.status === 'not_started'
        ? Circle
        : Clock3;
  const storyProgressRunId = storyProgress?.runId ?? execution.runId;
  return (
    <span className="lifecycle-badge" data-tone={presentation.tone} title={execution.rationale}>
      <Icon size={13} aria-hidden="true" />
      <span>{presentation.label}</span>
      {execution.runId !== null && !storyProgress && <span className="tabular-nums">· Run {execution.runId}</span>}
      {storyProgress && (
        <span
          className="tabular-nums"
          title={`${storyProgress.passed} of ${storyProgress.total} stories passed${storyProgressRunId === null ? '' : ` for run ${storyProgressRunId}`}`}
          aria-label={`${storyProgress.passed} of ${storyProgress.total} stories passed${storyProgressRunId === null ? '' : ` for run ${storyProgressRunId}`}`}
        >
          · {storyProgress.passed}/{storyProgress.total}
        </span>
      )}
    </span>
  );
}

export function LifecycleDeliveryBadge({ delivery }: { delivery: LifecyclePortfolioItem['delivery'] }) {
  const presentation = DELIVERY_PRESENTATION[delivery.status];
  return <span className="lifecycle-badge" data-tone={presentation.tone} title={delivery.rationale}><PackageCheck size={13} aria-hidden="true" /><span>{presentation.label}</span></span>;
}

export function LifecycleAssuranceBadge({ assurance }: { assurance: Assurance }) {
  const presentation = ASSURANCE_PRESENTATION[assurance.status];
  const Icon = assurance.status === 'complete' ? ShieldCheck : PackageOpen;
  const approvalGates = [
    ...('pendingPolicyApprovals' in assurance ? [`${assurance.pendingPolicyApprovals ?? 0} policy`] : []),
    ...('pendingHumanApprovals' in assurance ? [`${assurance.pendingHumanApprovals ?? 0} human`] : []),
  ].join(', ');
  const title = approvalGates
    ? `${assurance.rationale} Pending approval gates: ${approvalGates}.`
    : assurance.rationale;
  return <span className="lifecycle-badge" data-tone={presentation.tone} title={title}><Icon size={13} aria-hidden="true" /><span>{presentation.label}</span></span>;
}

export function LifecycleReadinessStates({
  readiness,
  assurance,
  delivery,
  storyProgress,
}: {
  readiness?: LifecycleReadinessProjection;
  assurance: LifecyclePortfolioItem['assurance'];
  delivery: LifecyclePortfolioItem['delivery'];
  storyProgress?: LifecycleStoryProgress;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Execution, assurance, and delivery readiness">
      <LifecycleExecutionBadge execution={readiness?.execution} storyProgress={storyProgress} />
      <LifecycleAssuranceBadge assurance={readiness?.assurance ?? assurance} />
      <LifecycleDeliveryBadge delivery={readiness?.delivery ?? delivery} />
    </span>
  );
}

const DEPENDENCY_PRESENTATION: Record<LifecycleDependencyStatus, { label: string; tone: string }> = {
  ready: { label: 'Dependencies ready', tone: 'passed' },
  waiting: { label: 'Waiting on dependencies', tone: 'approval' },
  blocked: { label: 'Dependencies blocked', tone: 'blocked' },
};

export function LifecycleDependencyBadge({ status }: { status?: LifecycleDependencyStatus }) {
  if (!status) {
    return <span className="lifecycle-badge" data-tone="muted"><GitBranch size={13} aria-hidden="true" /><span>Dependencies unknown</span></span>;
  }
  const presentation = DEPENDENCY_PRESENTATION[status];
  const Icon = status === 'ready' ? CheckCircle2 : status === 'waiting' ? Clock3 : AlertTriangle;
  return <span className="lifecycle-badge" data-tone={presentation.tone}><Icon size={13} aria-hidden="true" /><span>{presentation.label}</span></span>;
}

/** Neutral meta chip (owner, story progress, counts). */
export function LifecycleMetaChip({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="lifecycle-chip" title={title}>{children}</span>;
}
