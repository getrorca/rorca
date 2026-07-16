/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, RefreshCw, Search, X } from 'lucide-react';
import type { useLifecycle } from '../hooks/useLifecycle';
import type {
  LifecyclePhaseDescriptor,
  LifecyclePortfolioFilters,
  LifecycleSavedView,
} from '../types/lifecycle';

type LifecycleController = ReturnType<typeof useLifecycle>;

interface LifecycleToolbarProps {
  lifecycle: LifecycleController;
  phaseOrder: readonly LifecyclePhaseDescriptor[];
}

const STATUS_OPTIONS = [
  ['not_started', 'Not started'], ['in_progress', 'In progress'], ['blocked', 'Blocked'],
  ['awaiting_approval', 'Awaiting approval'], ['passed', 'Passed'], ['deferred', 'Deferred'],
  ['not_applicable', 'Not applicable'], ['stale', 'Stale'], ['needs_compilation', 'Needs compilation'],
] as const;
const RISK_OPTIONS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['critical', 'Critical']] as const;
const VIEW_OPTIONS = [
  ['current_view', 'Active delivery'], ['updated_desc', 'Recently updated'], ['title_asc', 'Spec title'],
  ['risk_desc', 'Highest risk'], ['readiness_desc', 'Most ready'], ['owner_asc', 'Owner'],
] as const;

function FilterClear({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-7 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-label={`Clear ${label} filter`}
    >
      <X size={13} aria-hidden="true" />
    </button>
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
  onClear,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <label className="relative flex min-w-[142px] items-center gap-2 rounded-md border border-border bg-bg px-2">
      <span className="shrink-0 text-xs font-medium text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`h-9 min-w-0 flex-1 appearance-none bg-transparent pr-7 text-xs focus-visible:outline-none ${value ? 'text-[var(--text)]' : 'text-muted'}`}
        aria-label={`${label} filter`}
      >
        <option value="">All</option>
        {options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
      </select>
      {value && <FilterClear label={label} onClick={onClear} />}
      <ChevronDown size={13} className="pointer-events-none absolute right-2 text-muted" aria-hidden="true" />
    </label>
  );
}

function filterSummary(filters: LifecyclePortfolioFilters): string[] {
  return [
    filters.search ? `Search: ${filters.search}` : '',
    filters.status ? `Status: ${filters.status.replace(/_/g, ' ')}` : '',
    filters.phase ? `Phase: ${filters.phase.replace(/_/g, ' ')}` : '',
    filters.risk ? `Risk: ${filters.risk}` : '',
    filters.owner ? `Owner: ${filters.owner}` : '',
    filters.blocked ? 'Blocked only' : '',
    filters.specStatus ? `Spec status: ${filters.specStatus}` : '',
    filters.disposition ? `Disposition: ${filters.disposition}` : '',
  ].filter(Boolean);
}

export default function LifecycleToolbar({ lifecycle, phaseOrder }: LifecycleToolbarProps) {
  const searchFilter = lifecycle.filters.search;
  const updateFilters = lifecycle.updateFilters;
  const [search, setSearch] = useState(searchFilter ?? '');
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [selectedViewId, setSelectedViewId] = useState('');
  const [viewError, setViewError] = useState('');

  useEffect(() => setSearch(searchFilter ?? ''), [searchFilter]);
  useEffect(() => {
    const normalized = search.trim();
    if (normalized === (searchFilter ?? '')) return;
    const timer = window.setTimeout(() => updateFilters({ search: normalized || undefined }, true), 300);
    return () => window.clearTimeout(timer);
  }, [search, searchFilter, updateFilters]);

  const owners = useMemo(() => {
    const values = new Map<string, string>();
    lifecycle.portfolio.data?.items.forEach((item) => {
      if (item.owner) values.set(item.owner.id, item.owner.label);
    });
    if (lifecycle.filters.owner && !values.has(lifecycle.filters.owner)) {
      values.set(lifecycle.filters.owner, lifecycle.filters.owner);
    }
    return [...values.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [lifecycle.portfolio.data?.items, lifecycle.filters.owner]);

  const summaries = filterSummary(lifecycle.filters);
  const activeCount = summaries.length;
  const selectedView = lifecycle.savedViews.find((view) => view.id === selectedViewId);
  const setFilter = <K extends keyof LifecyclePortfolioFilters>(key: K, value: LifecyclePortfolioFilters[K] | undefined) => {
    lifecycle.updateFilters({ [key]: value } as Partial<LifecyclePortfolioFilters>);
  };
  const resetAll = () => {
    setSearch('');
    setSelectedViewId('');
    lifecycle.updateFilters({
      search: undefined, status: undefined, specStatus: undefined, phase: undefined,
      risk: undefined, owner: undefined, blocked: undefined, disposition: undefined, sort: 'current_view',
    });
  };
  const selectSavedView = (id: string) => {
    setSelectedViewId(id);
    setViewError('');
    const view = lifecycle.savedViews.find((candidate) => candidate.id === id);
    if (view) {
      setViewName(view.name);
      lifecycle.applySavedView(view);
    }
  };
  const createView = () => {
    try {
      const view = lifecycle.saveView(viewName);
      setSelectedViewId(view.id);
      setViewName(view.name);
      setViewError('');
    } catch (error) {
      setViewError(error instanceof Error ? error.message : 'Could not save view');
    }
  };
  const renameView = () => {
    if (!selectedView) return;
    try {
      lifecycle.renameSavedView(selectedView.id, viewName);
      setViewError('');
    } catch (error) {
      setViewError(error instanceof Error ? error.message : 'Could not rename view');
    }
  };
  const deleteView = () => {
    if (!selectedView) return;
    lifecycle.removeSavedView(selectedView.id);
    setSelectedViewId('');
    setViewName('');
    setViewError('');
  };
  const refreshStatus = lifecycle.portfolio.error && lifecycle.portfolio.data
    ? `Refresh failed: ${lifecycle.portfolio.error.message}`
    : lifecycle.refreshing
      ? 'Refreshing lifecycle data…'
      : lifecycle.lastSuccessfulRefresh
        ? `Updated ${new Date(lifecycle.lastSuccessfulRefresh).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : 'Not refreshed yet';

  return (
    <section className="rounded-lg border border-border bg-panel" aria-label="Lifecycle filters">
      <div className="flex min-h-14 flex-wrap items-center gap-2 p-2">
        <label className="relative min-w-[210px] flex-1 lg:max-w-[320px]">
          <span className="sr-only">Search lifecycle specs</span>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-9 w-full rounded-md border border-border bg-bg pl-9 pr-8 text-sm text-[var(--text)] placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            placeholder="Search specs"
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(''); setFilter('search', undefined); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Clear search filter"
            ><X size={14} aria-hidden="true" /></button>
          )}
        </label>

        <SelectFilter
          label="Status"
          value={lifecycle.filters.status ?? ''}
          options={STATUS_OPTIONS}
          onChange={(value) => setFilter('status', value ? value as LifecyclePortfolioFilters['status'] : undefined)}
          onClear={() => setFilter('status', undefined)}
        />
        <SelectFilter
          label="Phase"
          value={lifecycle.filters.phase ?? ''}
          options={phaseOrder.map((phase) => [phase.id, phase.displayName] as const)}
          onChange={(value) => setFilter('phase', value ? value as LifecyclePortfolioFilters['phase'] : undefined)}
          onClear={() => setFilter('phase', undefined)}
        />

        <button
          type="button"
          aria-pressed={lifecycle.filters.blocked === true}
          onClick={() => setFilter('blocked', lifecycle.filters.blocked === true ? undefined : true)}
          className={`h-9 rounded-md border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            lifecycle.filters.blocked === true
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border bg-bg text-muted hover:text-[var(--text)]'
          }`}
        >Blocked only</button>

        <label className="relative flex min-w-[150px] items-center gap-2 rounded-md border border-border bg-bg px-2">
          <span className="text-xs font-medium text-muted">View</span>
          <select
            value={lifecycle.filters.sort}
            onChange={(event) => setFilter('sort', event.target.value as LifecyclePortfolioFilters['sort'])}
            className="h-9 min-w-0 flex-1 appearance-none bg-transparent pr-5 text-xs text-[var(--text)] focus-visible:outline-none"
            aria-label="Lifecycle view"
          >
            {VIEW_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute right-2 text-muted" aria-hidden="true" />
        </label>

        <button
          type="button"
          aria-pressed={lifecycle.urlState.compact}
          onClick={() => lifecycle.setCompact(!lifecycle.urlState.compact)}
          className={`h-9 rounded-md border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            lifecycle.urlState.compact ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg text-muted hover:text-[var(--text)]'
          }`}
        >Compact</button>

        <button
          type="button"
          aria-expanded={secondaryOpen}
          aria-controls="lifecycle-secondary-filters"
          onClick={() => setSecondaryOpen((open) => !open)}
          className={`h-9 rounded-md border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            secondaryOpen || activeCount > 0 ? 'border-accent/60 text-[var(--text)]' : 'border-border text-muted'
          }`}
        >More filters{activeCount > 0 ? ` (${activeCount})` : ''}</button>

        {activeCount > 0 && (
          <button type="button" onClick={resetAll} className="h-9 px-2 text-xs text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            Reset all
          </button>
        )}

        <button
          type="button"
          onClick={lifecycle.refresh}
          disabled={lifecycle.refreshing}
          className="ml-auto inline-flex h-9 items-center gap-2 rounded-md border border-border bg-bg px-3 text-xs font-medium text-muted hover:text-[var(--text)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Refresh Lifecycle Control"
        >
          <RefreshCw size={14} className={lifecycle.refreshing ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
        </button>
      </div>

      <div className="border-t border-border px-3 py-1.5 text-xs text-muted" aria-live="polite">
        <span className={lifecycle.portfolio.error && lifecycle.portfolio.data ? 'text-error' : ''}>{refreshStatus}</span>
        <span className="sr-only">{activeCount} active filters. {summaries.join('. ')}</span>
      </div>

      {secondaryOpen && (
        <div id="lifecycle-secondary-filters" className="flex flex-wrap items-end gap-2 border-t border-border bg-bg/40 p-3">
          <SelectFilter
            label="Risk"
            value={lifecycle.filters.risk ?? ''}
            options={RISK_OPTIONS}
            onChange={(value) => setFilter('risk', value ? value as LifecyclePortfolioFilters['risk'] : undefined)}
            onClear={() => setFilter('risk', undefined)}
          />
          <SelectFilter
            label="Owner"
            value={lifecycle.filters.owner ?? ''}
            options={owners}
            onChange={(value) => setFilter('owner', value || undefined)}
            onClear={() => setFilter('owner', undefined)}
          />

          <label className="min-w-[180px] flex-1 sm:max-w-[240px]">
            <span className="mb-1 block text-xs font-medium text-muted">Saved view</span>
            <select
              value={selectedViewId}
              onChange={(event) => selectSavedView(event.target.value)}
              className="h-9 w-full rounded-md border border-border bg-panel px-2 text-xs text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Saved view"
            >
              <option value="">Select a saved view</option>
              {lifecycle.savedViews.map((view: LifecycleSavedView) => <option key={view.id} value={view.id}>{view.name}</option>)}
            </select>
          </label>
          <label className="min-w-[170px] flex-1 sm:max-w-[230px]">
            <span className="mb-1 block text-xs font-medium text-muted">View name</span>
            <input
              value={viewName}
              maxLength={80}
              onChange={(event) => setViewName(event.target.value)}
              className="h-9 w-full rounded-md border border-border bg-panel px-3 text-xs text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              placeholder="My delivery view"
            />
          </label>
          <button type="button" onClick={createView} className="h-9 rounded-md bg-accent px-3 text-xs font-medium text-[var(--accent-contrast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Save current</button>
          <button type="button" disabled={!selectedView} onClick={renameView} className="h-9 rounded-md border border-border px-3 text-xs text-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Rename</button>
          <button type="button" disabled={!selectedView} onClick={deleteView} className="h-9 rounded-md border border-border px-3 text-xs text-error disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Delete</button>
          {viewError && <p className="w-full text-xs text-error" role="alert">{viewError}</p>}
        </div>
      )}
    </section>
  );
}
