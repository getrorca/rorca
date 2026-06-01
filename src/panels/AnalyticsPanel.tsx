/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, lazy, Suspense } from 'react';
import { BarChart3, Coins, DollarSign, TrendingUp, HeartPulse, Activity, Loader2 } from 'lucide-react';

/* ─── Lazy-loaded tab content ─────────────────────────────────────────────── */

const UsageDashboardPanel = lazy(() => import('./UsageDashboardPanel'));
const CostBreakdownPanel = lazy(() => import('./CostBreakdownPanel'));
const ModelComparisonPanel = lazy(() => import('./ModelComparisonPanel'));
const VelocityChartPanel = lazy(() => import('./VelocityChartPanel'));
const CompletionRatePanel = lazy(() => import('./CompletionRatePanel'));
const RoiCalculatorPanel = lazy(() => import('./RoiCalculatorPanel'));
const FinOpsDashboardPanel = lazy(() => import('./FinOpsDashboardPanel'));
const HealthDashboardPanel = lazy(() => import('./HealthDashboardPanel'));
const QueueHealthPanel = lazy(() => import('./QueueHealthPanel'));

/* ─── Tab definitions ─────────────────────────────────────────────────────── */

type AnalyticsTab = 'overview' | 'usage' | 'costs' | 'performance' | 'health' | 'queue';

interface TabDef {
  id: AnalyticsTab;
  label: string;
  icon: typeof BarChart3;
}

const TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'usage', label: 'Usage', icon: Coins },
  { id: 'costs', label: 'Costs', icon: DollarSign },
  { id: 'performance', label: 'Performance', icon: TrendingUp },
  { id: 'health', label: 'Health', icon: HeartPulse },
  { id: 'queue', label: 'Queue', icon: Activity },
];

/* ─── Loading fallback ────────────────────────────────────────────────────── */

function TabLoader() {
  return (
    <div className="flex items-center justify-center h-64 text-muted">
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  );
}

/* ─── Overview Tab (key metrics + sparklines) ─────────────────────────────── */
/*
 * Overview embeds the Usage panel (which already has summary cards + charts)
 * and the FinOps panel side by side. This gives the "6 metric cards + sparkline"
 * feel without duplicating API calls.
 */

/* ─── Component ───────────────────────────────────────────────────────────── */

export default function AnalyticsPanel() {
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('overview');

  return (
    <div className="flex flex-col h-full overflow-hidden" aria-label="Analytics dashboard">
      <h1 className="sr-only">Analytics</h1>
      {/* Tab bar */}
      <div className="shrink-0 border-b border-border bg-panel">
        <div className="flex items-center gap-1 px-4 pt-3 pb-0" role="tablist" aria-label="Analytics tabs">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                aria-controls={`analytics-tabpanel-${tab.id}`}
                id={`analytics-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-md transition-colors border-b-2 -mb-px ${
                  isActive
                    ? 'border-accent text-accent bg-bg'
                    : 'border-transparent text-muted hover:text-[var(--text)] hover:bg-surface-100'
                }`}
              >
                <Icon size={14} aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<TabLoader />}>
          {TABS.map((tab) => (
            <div
              key={tab.id}
              id={`analytics-tabpanel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`analytics-tab-${tab.id}`}
              hidden={activeTab !== tab.id}
              className={activeTab === tab.id ? 'h-full' : ''}
            >
              {activeTab === tab.id && <TabContent tab={tab.id} />}
            </div>
          ))}
        </Suspense>
      </div>
    </div>
  );
}

/* ─── Tab content router ──────────────────────────────────────────────────── */

function TabContent({ tab }: { tab: AnalyticsTab }) {
  switch (tab) {
    case 'overview':
      return <OverviewTab />;
    case 'usage':
      return <UsageDashboardPanel />;
    case 'costs':
      return <CostsTabWrapper />;
    case 'performance':
      return <PerformanceTab />;
    case 'health':
      return <HealthDashboardPanel />;
    case 'queue':
      return <QueueHealthWrapper />;
  }
}

/* ─── Overview Tab ────────────────────────────────────────────────────────── */
/*
 * Embeds UsageDashboardPanel which has: 4 summary metric cards, bar chart by
 * grouping, line chart over time, and a cost breakdown table. This IS the
 * overview — total tokens, total cost, avg cost/story, I/O ratio + 30-day trends.
 */

function OverviewTab() {
  return <UsageDashboardPanel />;
}

/* ─── Costs Tab ───────────────────────────────────────────────────────────── */
/*
 * Wraps both CostBreakdownPanel (cost by spec/run/model/period + pricing) and
 * FinOpsDashboardPanel (historical FinOps: daily trend, pie chart, savings).
 * User can toggle between the two with a sub-tab.
 */

type CostsSubTab = 'breakdown' | 'finops';

function CostsTabWrapper() {
  const [subTab, setSubTab] = useState<CostsSubTab>('breakdown');

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sub-tab selector */}
      <div className="shrink-0 px-4 py-2 bg-panel-alt border-b border-border flex items-center gap-1">
        {([
          { id: 'breakdown' as const, label: 'Cost Breakdown' },
          { id: 'finops' as const, label: 'FinOps Dashboard' },
        ]).map((st) => (
          <button
            key={st.id}
            onClick={() => setSubTab(st.id)}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              subTab === st.id
                ? 'bg-accent text-white'
                : 'text-muted hover:text-[var(--text)] hover:bg-surface-100'
            }`}
          >
            {st.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<TabLoader />}>
          {subTab === 'breakdown' ? <CostBreakdownPanel /> : <FinOpsDashboardPanel />}
        </Suspense>
      </div>
    </div>
  );
}

/* ─── Performance Tab ─────────────────────────────────────────────────────── */
/*
 * Combines: ModelComparison, Velocity, Completion, and ROI.
 * User picks via sub-tabs.
 */

type PerfSubTab = 'models' | 'velocity' | 'completion' | 'roi';

function PerformanceTab() {
  const [subTab, setSubTab] = useState<PerfSubTab>('models');

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sub-tab selector */}
      <div className="shrink-0 px-4 py-2 bg-panel-alt border-b border-border flex items-center gap-1">
        {([
          { id: 'models' as const, label: 'Models' },
          { id: 'velocity' as const, label: 'Velocity' },
          { id: 'completion' as const, label: 'Completion' },
          { id: 'roi' as const, label: 'ROI' },
        ]).map((st) => (
          <button
            key={st.id}
            onClick={() => setSubTab(st.id)}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
              subTab === st.id
                ? 'bg-accent text-white'
                : 'text-muted hover:text-[var(--text)] hover:bg-surface-100'
            }`}
          >
            {st.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<TabLoader />}>
          {subTab === 'models' && <ModelComparisonPanel />}
          {subTab === 'velocity' && <VelocityChartPanel />}
          {subTab === 'completion' && <CompletionRatePanel />}
          {subTab === 'roi' && <RoiCalculatorPanel />}
        </Suspense>
      </div>
    </div>
  );
}

/* ─── Queue Health Tab ─────────────────────────────────────────────────────── */

function QueueHealthWrapper() {
  return (
    <div className="h-full overflow-y-auto p-4">
      <Suspense fallback={<TabLoader />}>
        <QueueHealthPanel />
      </Suspense>
    </div>
  );
}
