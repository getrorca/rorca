/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Bookmark,
  Check,
  ChevronDown,
  ListFilter,
  RefreshCw,
  Rows3,
  Search,
  Table2,
  X,
} from 'lucide-react';
import type { useLifecycle } from '../hooks/useLifecycle';
import {
  formatLifecycleQuery,
  lifecycleQuerySuggestions,
  lifecycleSortLabel,
  parseLifecycleQuery,
  type LifecycleQuerySuggestion,
} from '../lib/lifecycle-query';
import type {
  LifecyclePhaseDescriptor,
  LifecyclePortfolioFilters,
  LifecycleSavedView,
} from '../types/lifecycle';

export type LifecycleController = ReturnType<typeof useLifecycle>;

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

interface FilterChip { key: keyof LifecyclePortfolioFilters; label: string }

function labelValue(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function filterChips(filters: LifecyclePortfolioFilters, ownerLabel?: string): FilterChip[] {
  return [
    filters.search ? { key: 'search' as const, label: `Search: ${filters.search}` } : null,
    filters.status ? { key: 'status' as const, label: `Status: ${labelValue(filters.status)}` } : null,
    filters.phase ? { key: 'phase' as const, label: `Phase: ${labelValue(filters.phase)}` } : null,
    filters.risk ? { key: 'risk' as const, label: `Risk: ${labelValue(filters.risk)}` } : null,
    filters.owner ? { key: 'owner' as const, label: `Owner: ${ownerLabel ?? filters.owner}` } : null,
    filters.blocked !== undefined ? { key: 'blocked' as const, label: filters.blocked ? 'Blocked' : 'Not blocked' } : null,
    filters.specStatus ? { key: 'specStatus' as const, label: `Spec: ${labelValue(filters.specStatus)}` } : null,
    filters.disposition ? { key: 'disposition' as const, label: `Disposition: ${labelValue(filters.disposition)}` } : null,
    filters.sort !== 'current_view' ? { key: 'sort' as const, label: `View: ${lifecycleSortLabel(filters.sort)}` } : null,
  ].filter((value): value is FilterChip => value !== null);
}

function ChoiceGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-xs font-semibold text-[var(--text)]">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map(([optionValue, optionLabel]) => {
          const selected = value === optionValue;
          return (
            <button
              key={optionValue}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(selected ? undefined : optionValue)}
              className={`inline-flex min-h-8 items-center gap-1 rounded-md border px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                selected ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-panel text-muted hover:text-[var(--text)]'
              }`}
            >
              {selected && <Check size={12} aria-hidden="true" />}{optionLabel}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function QuerySuggestions({
  suggestions,
  highlighted,
  onChoose,
}: {
  suggestions: LifecycleQuerySuggestion[];
  highlighted: number;
  onChoose: (suggestion: LifecycleQuerySuggestion) => void;
}) {
  return (
    <div
      id="lifecycle-query-suggestions"
      role="listbox"
      aria-label="Lifecycle query suggestions"
      className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-40 max-h-72 overflow-y-auto rounded-lg border border-border bg-panel p-1 shadow-lg"
    >
      {suggestions.map((suggestion, index) => (
        <button
          key={suggestion.id}
          id={`lifecycle-query-${suggestion.id}`}
          type="button"
          role="option"
          aria-selected={index === highlighted}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(suggestion)}
          className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            index === highlighted ? 'bg-accent/10 text-[var(--text)]' : 'text-muted hover:bg-surface-200 hover:text-[var(--text)]'
          }`}
        >
          <span className="text-xs font-medium">{suggestion.label}</span>
          <span className="truncate font-mono text-[0.6875rem] text-muted">{suggestion.description}</span>
        </button>
      ))}
    </div>
  );
}

export default function LifecycleToolbar({ lifecycle, phaseOrder }: LifecycleToolbarProps) {
  const canonicalQuery = formatLifecycleQuery(lifecycle.filters);
  const [query, setQuery] = useState(canonicalQuery);
  const [queryFocused, setQueryFocused] = useState(false);
  const [queryErrors, setQueryErrors] = useState<string[]>([]);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0);
  const [secondaryOpen, setSecondaryOpen] = useState(false);
  const [ownerSearch, setOwnerSearch] = useState('');
  const [viewName, setViewName] = useState('');
  const [selectedViewId, setSelectedViewId] = useState('');
  const [viewError, setViewError] = useState('');
  const queryRef = useRef<HTMLInputElement>(null);

  useEffect(() => setQuery(canonicalQuery), [canonicalQuery]);

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

  const suggestions = useMemo(
    () => queryFocused ? lifecycleQuerySuggestions(query, owners) : [],
    [owners, query, queryFocused],
  );
  useEffect(() => setHighlightedSuggestion(0), [query]);

  const applyQuery = (value: string) => {
    const parsed = parseLifecycleQuery(value);
    setQueryErrors(parsed.errors);
    if (parsed.errors.length > 0) return;
    lifecycle.updateFilters({
      search: parsed.freeText || undefined,
      status: parsed.filters.status,
      specStatus: parsed.filters.specStatus,
      phase: parsed.filters.phase,
      risk: parsed.filters.risk,
      owner: parsed.filters.owner,
      blocked: parsed.filters.blocked,
      disposition: parsed.filters.disposition,
      sort: parsed.filters.sort ?? 'current_view',
    }, true);
  };

  useEffect(() => {
    if (query === canonicalQuery) {
      setQueryErrors([]);
      return;
    }
    const timer = window.setTimeout(() => applyQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
    // applyQuery intentionally closes over the current controller; canonical
    // query changes are the synchronization boundary for URL-backed filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, canonicalQuery]);

  const chooseSuggestion = (suggestion: LifecycleQuerySuggestion) => {
    setQuery(suggestion.replacement);
    setQueryErrors([]);
    setQueryFocused(true);
    window.setTimeout(() => queryRef.current?.focus(), 0);
  };
  const onQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      setHighlightedSuggestion((value) => (value + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      setHighlightedSuggestion((value) => (value - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter' && suggestions[highlightedSuggestion]) {
      event.preventDefault();
      chooseSuggestion(suggestions[highlightedSuggestion]);
    } else if (event.key === 'Escape') {
      setQueryFocused(false);
    }
  };

  const setFilter = <K extends keyof LifecyclePortfolioFilters>(key: K, value: LifecyclePortfolioFilters[K] | undefined) => {
    lifecycle.updateFilters({ [key]: value } as Partial<LifecyclePortfolioFilters>);
  };
  const clearAll = () => {
    setSelectedViewId('');
    setQuery('');
    setQueryErrors([]);
    lifecycle.updateFilters({
      search: undefined, status: undefined, specStatus: undefined, phase: undefined,
      risk: undefined, owner: undefined, blocked: undefined, disposition: undefined, sort: 'current_view',
    });
  };

  const selectedView = lifecycle.savedViews.find((view) => view.id === selectedViewId);
  const selectSavedView = (view: LifecycleSavedView) => {
    setSelectedViewId(view.id);
    setViewName(view.name);
    setViewError('');
    lifecycle.applySavedView(view);
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

  const ownerLabel = owners.find(([id]) => id === lifecycle.filters.owner)?.[1];
  const chips = filterChips(lifecycle.filters, ownerLabel);
  const ownerOptions = owners.filter(([, label]) => label.toLowerCase().includes(ownerSearch.trim().toLowerCase()));
  const refreshStatus = lifecycle.portfolio.error && lifecycle.portfolio.data
    ? `Refresh failed: ${lifecycle.portfolio.error.message}`
    : lifecycle.refreshing
      ? 'Refreshing lifecycle data…'
      : lifecycle.lastSuccessfulRefresh
        ? `Updated ${new Date(lifecycle.lastSuccessfulRefresh).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : 'Not refreshed yet';

  const presets = [
    {
      label: 'Active',
      active: lifecycle.filters.status === 'in_progress',
      apply: { status: 'in_progress' as const },
      clear: { status: undefined },
    },
    {
      label: 'Blocked',
      active: lifecycle.filters.blocked === true,
      apply: { blocked: true as const },
      clear: { blocked: undefined },
    },
    {
      label: 'Ready for QA',
      active: lifecycle.filters.phase === 'qa' && lifecycle.filters.blocked === false,
      apply: { phase: 'qa' as const, blocked: false as const },
      clear: { phase: undefined, blocked: undefined },
    },
    {
      label: 'Approvals',
      active: lifecycle.filters.status === 'awaiting_approval',
      apply: { status: 'awaiting_approval' as const },
      clear: { status: undefined },
    },
  ];

  return (
    <section className="rounded-lg border border-border bg-panel" aria-label="Lifecycle filters">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <div className="inline-flex rounded-md border border-border bg-bg p-0.5" role="group" aria-label="Lifecycle view mode">
          <button
            type="button"
            aria-pressed={lifecycle.urlState.mode === 'explorer'}
            onClick={() => lifecycle.setMode('explorer')}
            className={`inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${lifecycle.urlState.mode === 'explorer' ? 'bg-accent text-[var(--accent-contrast)]' : 'text-muted hover:text-[var(--text)]'}`}
          ><Rows3 size={13} aria-hidden="true" /> Explorer</button>
          <button
            type="button"
            aria-pressed={lifecycle.urlState.mode === 'matrix'}
            onClick={() => lifecycle.setMode('matrix')}
            className={`inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${lifecycle.urlState.mode === 'matrix' ? 'bg-accent text-[var(--accent-contrast)]' : 'text-muted hover:text-[var(--text)]'}`}
          ><Table2 size={13} aria-hidden="true" /> Matrix</button>
        </div>

        <div className="relative min-w-[240px] flex-1">
          <label htmlFor="lifecycle-query" className="sr-only">Search and filter lifecycle specs</label>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            ref={queryRef}
            id="lifecycle-query"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls="lifecycle-query-suggestions"
            aria-activedescendant={suggestions[highlightedSuggestion] ? `lifecycle-query-${suggestions[highlightedSuggestion].id}` : undefined}
            aria-invalid={queryErrors.length > 0}
            value={query}
            onFocus={() => setQueryFocused(true)}
            onBlur={() => window.setTimeout(() => setQueryFocused(false), 100)}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onQueryKeyDown}
            className="h-9 w-full rounded-md border border-border bg-bg pl-9 pr-9 text-sm text-[var(--text)] placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            placeholder="Search or filter — try status:blocked phase:qa"
          />
          {query && (
            <button
              type="button"
              onClick={clearAll}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Clear lifecycle query"
            ><X size={14} aria-hidden="true" /></button>
          )}
          {suggestions.length > 0 && <QuerySuggestions suggestions={suggestions} highlighted={highlightedSuggestion} onChoose={chooseSuggestion} />}
        </div>

        {lifecycle.urlState.mode === 'matrix' && (
          <button
            type="button"
            aria-pressed={lifecycle.urlState.compact}
            onClick={() => lifecycle.setCompact(!lifecycle.urlState.compact)}
            className={`h-9 rounded-md border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              lifecycle.urlState.compact ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg text-muted hover:text-[var(--text)]'
            }`}
          >Compact matrix</button>
        )}

        <button
          type="button"
          aria-expanded={secondaryOpen}
          aria-controls="lifecycle-secondary-filters"
          onClick={() => setSecondaryOpen((open) => !open)}
          className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            secondaryOpen ? 'border-accent text-[var(--text)]' : 'border-border bg-bg text-muted hover:text-[var(--text)]'
          }`}
        ><ListFilter size={13} aria-hidden="true" /> Filters <ChevronDown size={13} aria-hidden="true" /></button>

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

      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2" aria-label="Lifecycle presets">
        <span className="mr-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">Focus</span>
        {presets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            aria-pressed={preset.active}
            onClick={() => lifecycle.updateFilters(preset.active ? preset.clear : preset.apply)}
            className={`min-h-8 rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              preset.active ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-[var(--text)]'
            }`}
          >{preset.label}</button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t border-border px-3 py-2" aria-label="Phase facets">
        <span className="mr-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">Phase</span>
        <button
          type="button"
          aria-pressed={!lifecycle.filters.phase}
          onClick={() => setFilter('phase', undefined)}
          className={`min-h-8 rounded-md px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${!lifecycle.filters.phase ? 'bg-accent text-[var(--accent-contrast)]' : 'text-muted hover:bg-surface-200 hover:text-[var(--text)]'}`}
        >All</button>
        {phaseOrder.map((phase) => (
          <button
            key={phase.id}
            type="button"
            aria-pressed={lifecycle.filters.phase === phase.id}
            onClick={() => setFilter('phase', lifecycle.filters.phase === phase.id ? undefined : phase.id)}
            className={`min-h-8 rounded-md px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${lifecycle.filters.phase === phase.id ? 'bg-accent text-[var(--accent-contrast)]' : 'text-muted hover:bg-surface-200 hover:text-[var(--text)]'}`}
          >{phase.displayName}</button>
        ))}
      </div>

      {(chips.length > 0 || queryErrors.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border bg-bg/40 px-3 py-2">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setFilter(chip.key, chip.key === 'sort' ? 'current_view' : undefined)}
              className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-full border border-accent/50 bg-accent/10 px-2.5 text-xs text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={`Remove ${chip.label} filter`}
            ><span className="truncate">{chip.label}</span><X size={12} className="shrink-0" aria-hidden="true" /></button>
          ))}
          {chips.length > 0 && (
            <button type="button" onClick={clearAll} className="min-h-7 px-2 text-xs text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Clear all</button>
          )}
          {queryErrors.length > 0 && <p className="w-full text-xs text-error" role="alert">{queryErrors.join('. ')}</p>}
        </div>
      )}

      {secondaryOpen && (
        <div id="lifecycle-secondary-filters" className="grid gap-4 border-t border-border bg-bg/40 p-3 lg:grid-cols-2 xl:grid-cols-3">
          <ChoiceGroup
            label="Status"
            value={lifecycle.filters.status ?? ''}
            options={STATUS_OPTIONS}
            onChange={(value) => setFilter('status', value as LifecyclePortfolioFilters['status'] | undefined)}
          />
          <ChoiceGroup
            label="Risk"
            value={lifecycle.filters.risk ?? ''}
            options={RISK_OPTIONS}
            onChange={(value) => setFilter('risk', value as LifecyclePortfolioFilters['risk'] | undefined)}
          />
          <ChoiceGroup
            label="Sort view"
            value={lifecycle.filters.sort}
            options={VIEW_OPTIONS}
            onChange={(value) => setFilter('sort', value as LifecyclePortfolioFilters['sort'] ?? 'current_view')}
          />

          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-xs font-semibold text-[var(--text)]">Owner</legend>
            <label className="sr-only" htmlFor="lifecycle-owner-search">Search owners</label>
            <input
              id="lifecycle-owner-search"
              value={ownerSearch}
              onChange={(event) => setOwnerSearch(event.target.value)}
              className="mb-2 h-8 w-full rounded-md border border-border bg-panel px-2.5 text-xs text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              placeholder="Search owners"
            />
            <div className="max-h-32 space-y-1 overflow-y-auto" role="group" aria-label="Owner choices">
              {ownerOptions.length > 0 ? ownerOptions.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={lifecycle.filters.owner === id}
                  onClick={() => setFilter('owner', lifecycle.filters.owner === id ? undefined : id)}
                  className="flex min-h-8 w-full items-center justify-between rounded-md px-2 text-left text-xs text-muted hover:bg-panel hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                ><span className="truncate">{label}</span>{lifecycle.filters.owner === id && <Check size={13} aria-hidden="true" />}</button>
              )) : <p className="px-2 py-1 text-xs text-muted">No owners on this page</p>}
            </div>
          </fieldset>

          <div className="min-w-0 lg:col-span-2">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]"><Bookmark size={13} aria-hidden="true" /> Saved views</div>
            <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Saved views">
              {lifecycle.savedViews.length > 0 ? lifecycle.savedViews.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  aria-pressed={selectedViewId === view.id}
                  onClick={() => selectSavedView(view)}
                  className={`min-h-8 rounded-md border px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${selectedViewId === view.id ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-panel text-muted'}`}
                >{view.name}</button>
              )) : <span className="text-xs text-muted">No saved views yet</span>}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[170px] flex-1">
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
            </div>
            {viewError && <p className="mt-1 text-xs text-error" role="alert">{viewError}</p>}
          </div>
        </div>
      )}

      <div className="border-t border-border px-3 py-1.5 text-xs text-muted" aria-live="polite">
        <span className={lifecycle.portfolio.error && lifecycle.portfolio.data ? 'text-error' : ''}>{refreshStatus}</span>
        <span className="sr-only">{chips.length} active filters. {chips.map((chip) => chip.label).join('. ')}</span>
      </div>
    </section>
  );
}
