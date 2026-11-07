/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Activity, AlertTriangle, CheckCircle2, Gauge, Hourglass, Layers, OctagonAlert, type LucideIcon } from 'lucide-react';
import type { LifecyclePortfolioResponse } from '../types/lifecycle';

interface LifecycleMetricsProps {
  kpis: LifecyclePortfolioResponse['kpis'];
}

interface MetricDefinition {
  label: string;
  value: string | number;
  detail: string;
  icon: LucideIcon;
  /** Semantic tone for the icon tile; keeps "lifecycle-blocked" and "readiness blockers" unmistakably distinct. */
  tone: 'accent' | 'blocked' | 'approval' | 'passed' | 'muted';
}

export default function LifecycleMetrics({ kpis }: LifecycleMetricsProps) {
  const metrics: MetricDefinition[] = [
    { label: 'Lifecycle candidates', value: kpis.specs, detail: `${kpis.evaluatedSpecs} evaluated · ${kpis.needsCompilation} unassessed`, icon: Layers, tone: 'accent' },
    { label: 'Delivered', value: kpis.deliveredSpecs, detail: 'Historical or current delivery', icon: CheckCircle2, tone: 'passed' },
    { label: 'In progress', value: kpis.inProgressSpecs, detail: 'Delivery activity', icon: Activity, tone: 'accent' },
    { label: 'Needs reconciliation', value: kpis.needsReconciliation, detail: 'Assurance incomplete', icon: AlertTriangle, tone: 'approval' },
    { label: 'Blocked', value: kpis.blockedSpecs, detail: 'Canonical blockers', icon: OctagonAlert, tone: 'blocked' },
    { label: 'Assurance complete', value: kpis.assuranceComplete, detail: 'Controls fully satisfied', icon: Gauge, tone: 'passed' },
    { label: 'Waiting approval gates', value: kpis.waitingApprovals, detail: 'Unique active unresolved gates', icon: Hourglass, tone: 'approval' },
  ];

  return (
    <section className="grid min-h-[88px] grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-7" aria-label="Lifecycle totals">
      {metrics.map((metric) => (
        <div key={metric.label} className="lifecycle-metric" data-tone={metric.tone}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xl font-semibold leading-none tabular-nums text-[var(--text)]">{metric.value}</div>
            <span className="lifecycle-metric__icon" aria-hidden="true"><metric.icon size={15} /></span>
          </div>
          <div className="mt-2 text-xs font-medium leading-tight text-[var(--text)]">{metric.label}</div>
          <div className="mt-0.5 text-xs leading-tight tabular-nums text-muted">{metric.detail}</div>
        </div>
      ))}
    </section>
  );
}
