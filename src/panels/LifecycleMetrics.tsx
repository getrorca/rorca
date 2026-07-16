/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { LifecyclePortfolioResponse } from '../types/lifecycle';

interface LifecycleMetricsProps {
  kpis: LifecyclePortfolioResponse['kpis'];
}

export default function LifecycleMetrics({ kpis }: LifecycleMetricsProps) {
  const completionPercent = Math.round(kpis.phases.completionRate * 100);
  const metrics = [
    { label: 'Active specs', value: kpis.activeSpecs, detail: `${kpis.evaluatedSpecs} evaluated` },
    { label: 'Lifecycle coverage', value: `${completionPercent}%`, detail: `${kpis.phases.passed}/${kpis.phases.denominator} required phases` },
    { label: 'Blocked specs', value: kpis.blockedSpecs, detail: `${kpis.missingGates} missing gates` },
    { label: 'Ready for QA', value: kpis.readyForQa, detail: 'Delivery candidates' },
    { label: 'Waiting approvals', value: kpis.waitingApprovals, detail: 'Governed decisions' },
    { label: 'Recent transitions', value: kpis.recentPhaseTransitions, detail: 'Last 24 hours' },
  ];

  return (
    <section className="grid min-h-[88px] grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" aria-label="Lifecycle totals">
      {metrics.map((metric) => (
        <div key={metric.label} className="min-w-0 rounded-lg border border-border bg-panel px-3 py-2.5" title={`${metric.label}: ${metric.value}. ${metric.detail}`}>
          <div className="truncate text-xl font-semibold leading-none tabular-nums text-[var(--text)]">{metric.value}</div>
          <div className="mt-2 truncate text-xs font-medium text-[var(--text)]">{metric.label}</div>
          <div className="mt-0.5 truncate text-xs tabular-nums text-muted">{metric.detail}</div>
        </div>
      ))}
    </section>
  );
}
