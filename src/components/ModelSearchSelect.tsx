/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Search, ChevronDown, ChevronRight, Check, Sparkles, Zap, Clock, Turtle, Brain } from 'lucide-react';

/** Inline shape matching the backend ReasoningCapability — kept here to avoid a cross-package import. */
export interface ReasoningCapability {
  supportsReasoning: boolean;
  reasoningType: 'anthropic-thinking' | 'effort-levels' | 'native-cot' | 'none';
  effortLevels: string[];
  defaultEffort: string | null;
  budgetTokensSupported: boolean;
  budgetRange: [number, number] | null;
  costMultiplier?: Record<string, number>;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  providerType?: string;
  costPer1kInput: number;
  costPer1kOutput: number;
  contextWindow?: number;
  speedTier?: string;
  costTier?: string;
  recommended: boolean;
  /** Whether this model supports reasoning/thinking. */
  supportsReasoning?: boolean;
  /** Effort levels supported by this model (e.g. ['low', 'medium', 'high', 'max']). */
  effortLevels?: string[];
  /** Full reasoning capability descriptor returned by the backend. */
  reasoningCapability?: ReasoningCapability;
}

interface ModelSearchSelectProps {
  models: ModelOption[];
  value: string;
  defaultModelId?: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

function formatCost(cost: number): string {
  if (cost === 0) return 'Free';
  if (cost < 0.001) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

function formatContext(ctx: number): string {
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
  return `${Math.round(ctx / 1000)}K`;
}

const SpeedIcon = ({ tier }: { tier?: string }) => {
  if (tier === 'fast') return <Zap size={10} className="text-emerald-400" />;
  if (tier === 'slow') return <Turtle size={10} className="text-amber-400" />;
  return <Clock size={10} className="text-muted/50" />;
};

export default function ModelSearchSelect({ models, value, defaultModelId, onChange, disabled }: ModelSearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(['OpenRouter']));
  const [showAllOpenRouter, setShowAllOpenRouter] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fixed position for dropdown (escapes overflow-hidden parents)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const selected = models.find(m => m.id === value);

  // Auto-expand OpenRouter when the effective model belongs to OpenRouter
  useEffect(() => {
    if (!open) return;
    const effectiveModel = models.find(m => m.id === value);
    if (effectiveModel?.provider === 'OpenRouter') {
      setCollapsed(prev => {
        if (!prev.has('OpenRouter')) return prev;
        const next = new Set(prev);
        next.delete('OpenRouter');
        return next;
      });
    }
  }, [open, value, models]);

  // Auto-expand OpenRouter when search/filter produces OpenRouter results
  useEffect(() => {
    if (!open) return;
    const q = query.toLowerCase().trim();
    if (!q) return;
    const hasOrResults = models.some(m =>
      m.provider === 'OpenRouter' && (
        m.label.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
      )
    );
    if (hasOrResults) {
      setCollapsed(prev => {
        if (!prev.has('OpenRouter')) return prev;
        const next = new Set(prev);
        next.delete('OpenRouter');
        return next;
      });
    }
  }, [query, open, models]);

  // Reset collapse state when dropdown closes
  useEffect(() => {
    if (!open) {
      setCollapsed(new Set(['OpenRouter']));
      setShowAllOpenRouter(false);
    }
  }, [open]);

  const toggleCollapsed = useCallback((label: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
        if (label === 'OpenRouter') setShowAllOpenRouter(false);
      }
      return next;
    });
  }, []);

  // Filter + group models
  const { groups } = useMemo(() => {
    const q = query.toLowerCase().trim();
    const filtered = q
      ? models.filter(m =>
          m.label.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q)
        )
      : models;

    // Separate recommended, then group by provider
    const recommended: ModelOption[] = [];
    const byProvider = new Map<string, ModelOption[]>();

    for (const m of filtered) {
      if (m.recommended) recommended.push(m);
      const group = byProvider.get(m.provider) ?? [];
      group.push(m);
      byProvider.set(m.provider, group);
    }

    // Build ordered groups: recommended first, then non-OpenRouter providers, then OpenRouter
    const groups: { label: string; models: ModelOption[] }[] = [];
    if (recommended.length > 0 && !q) {
      groups.push({ label: 'Recommended', models: recommended });
    }

    // Non-OpenRouter providers first
    for (const [provider, provModels] of byProvider) {
      if (provider !== 'OpenRouter') {
        groups.push({ label: provider, models: provModels });
      }
    }
    // OpenRouter last (largest group)
    const orModels = byProvider.get('OpenRouter');
    if (orModels) {
      groups.push({ label: 'OpenRouter', models: orModels });
    }

    // Dedupe (recommended models appear in their provider group too)
    const seen = new Set<string>();
    const deduped: ModelOption[] = [];
    for (const g of groups) {
      for (const m of g.models) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          deduped.push(m);
        }
      }
    }

    return { groups };
  }, [models, query]);

  // Reset highlight on filter change
  useEffect(() => { setHighlightIdx(0); }, [query]);

  // Calculate dropdown position and focus input when opening
  useEffect(() => {
    if (open) {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const dropdownHeight = 340; // max-h-80 = 320px + search bar ~40px
        // Open upward if not enough space below
        const openUp = spaceBelow < dropdownHeight && rect.top > spaceBelow;
        setDropdownPos({
          top: openUp ? rect.top - dropdownHeight : rect.bottom + 4,
          left: rect.left,
          width: rect.width,
        });
      }
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery('');
      setDropdownPos(null);
    }
  }, [open]);

  // Close on click outside (check both trigger container and fixed dropdown)
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-model-item]');
    items[highlightIdx]?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx, open]);

  // Effective flat list excludes models from collapsed groups (for keyboard nav)
  const visibleFlatList = useMemo(() => {
    const seen = new Set<string>();
    const result: ModelOption[] = [];
    for (const g of groups) {
      if (collapsed.has(g.label)) continue;
      for (const m of g.models) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          result.push(m);
        }
      }
    }
    return result;
  }, [groups, collapsed]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIdx(i => Math.min(i + 1, visibleFlatList.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIdx(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (visibleFlatList[highlightIdx]) {
          onChange(visibleFlatList[highlightIdx].id);
          setOpen(false);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
    }
  }, [open, visibleFlatList, highlightIdx, onChange]);

  // Track flat index across groups for highlighting
  let flatIdx = -1;
  const seenIds = new Set<string>();

  return (
    <div ref={containerRef} className="relative w-full" onKeyDown={handleKeyDown}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm bg-panel border border-border rounded text-text outline-none hover:border-accent/50 focus:border-accent transition-colors text-left ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Select LLM model"
      >
        {selected ? (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="truncate font-medium">{selected.label}</span>
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-surface-200 text-muted font-mono">
              {formatCost(selected.costPer1kInput)}/1K
            </span>
            {selected.contextWindow && (
              <span className="shrink-0 text-[10px] text-muted/50 font-mono">
                {formatContext(selected.contextWindow)}
              </span>
            )}
          </div>
        ) : (
          <span className="text-muted/50">Select model...</span>
        )}
        <ChevronDown
          size={14}
          className={`text-muted/60 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown — fixed position to escape overflow-hidden parents */}
      {open && dropdownPos && (
        <div
          ref={dropdownRef}
          className="fixed bg-[var(--panel)] border border-[var(--border)] rounded-lg z-[9999] overflow-hidden"
          style={{
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            boxShadow: '0 4px 24px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.12)',
          }}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
            <Search size={14} className="text-muted/50 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search models..."
              className="flex-1 bg-transparent text-sm text-text placeholder:text-muted/40 outline-none"
              aria-label="Search models"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="text-[10px] text-muted/50 hover:text-muted transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {/* Model list */}
          <div ref={listRef} className="max-h-80 overflow-y-auto" role="listbox">
            {groups.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted">
                No models match "{query}"
              </div>
            ) : (
              groups.map(group => {
                // Check if all models in this group were already shown (dedup)
                const newModels = group.models.filter(m => !seenIds.has(m.id));
                if (newModels.length === 0) return null;

                const isCollapsed = collapsed.has(group.label);
                const isCollapsible = group.label !== 'Recommended';

                return (
                  <div key={group.label}>
                    {/* Group header */}
                    {isCollapsible ? (
                      <button
                        type="button"
                        onClick={() => toggleCollapsed(group.label)}
                        className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/60 bg-[var(--bg)] sticky top-0 hover:text-muted transition-colors cursor-pointer"
                      >
                        <span>{group.label}</span>
                        <span className="flex items-center gap-1.5">
                          {isCollapsed && (
                            <span className="text-[9px] font-normal normal-case tracking-normal text-muted/40">
                              {newModels.length} models
                            </span>
                          )}
                          {isCollapsed
                            ? <ChevronRight size={10} className="text-muted/40" />
                            : <ChevronDown size={10} className="text-muted/40" />
                          }
                        </span>
                      </button>
                    ) : (
                      <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/60 bg-[var(--bg)] sticky top-0">
                        <Sparkles size={10} className="inline mr-1 text-amber-400" />
                        {group.label}
                      </div>
                    )}

                    {/* Models — hidden when collapsed */}
                    {!isCollapsed && (() => {
                      const OR_PAGE = 30;
                      const isOpenRouter = group.label === 'OpenRouter';
                      const activeSearch = query.trim().length > 0;

                      // For OpenRouter without active search: hoist selected model, then paginate
                      let modelsToRender: ModelOption[];
                      let hoistedSelected: ModelOption | null = null;
                      let remainingCount = 0;

                      if (isOpenRouter && !activeSearch) {
                        const undeduped = group.models.filter(m => !seenIds.has(m.id));
                        const selectedInGroup = undeduped.find(m => m.id === value) ?? null;
                        const rest = selectedInGroup
                          ? undeduped.filter(m => m.id !== value)
                          : undeduped;

                        if (!showAllOpenRouter) {
                          // If selected model exists in this group, reserve a slot for it
                          const slots = selectedInGroup ? OR_PAGE - 1 : OR_PAGE;
                          const sliced = rest.slice(0, slots);
                          remainingCount = rest.length - sliced.length;
                          hoistedSelected = selectedInGroup;
                          modelsToRender = sliced;
                        } else {
                          hoistedSelected = selectedInGroup;
                          modelsToRender = rest;
                        }
                      } else {
                        modelsToRender = group.models.filter(m => !seenIds.has(m.id));
                      }

                      const renderModelButton = (m: ModelOption) => {
                        seenIds.add(m.id);
                        flatIdx++;
                        const idx = flatIdx;
                        const isSelected = m.id === value;
                        const isHighlighted = idx === highlightIdx;
                        return (
                          <button
                            key={m.id}
                            data-model-item
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            onClick={() => { onChange(m.id); setOpen(false); }}
                            onMouseEnter={() => setHighlightIdx(idx)}
                            className={`w-full text-left px-3 py-1.5 text-[13px] transition-colors flex items-center gap-2 ${
                              isHighlighted
                                ? 'bg-accent/8 text-[var(--text)]'
                                : 'text-[var(--text)]/80 hover:bg-[var(--surface-100)]'
                            }`}
                          >
                            <span className="w-3.5 shrink-0">
                              {isSelected && <Check size={12} className="text-accent" />}
                            </span>
                            <div className="flex-1 min-w-0 flex items-center gap-2">
                              <span className={`truncate ${isSelected ? 'font-medium' : ''}`}>
                                {m.label}
                              </span>
                              {m.supportsReasoning && (
                                <span
                                  title={m.effortLevels && m.effortLevels.length > 0
                                    ? `Supports reasoning: ${m.effortLevels.join(', ')} effort`
                                    : 'Supports native reasoning'}
                                  className="shrink-0"
                                >
                                  <Brain size={11} className="text-violet-400" />
                                </span>
                              )}
                              {m.id === defaultModelId && (
                                <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-accent/10 text-accent font-medium">
                                  Default
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <SpeedIcon tier={m.speedTier} />
                              {m.contextWindow && (
                                <span className="text-[10px] font-mono text-muted/40 tabular-nums w-8 text-right">
                                  {formatContext(m.contextWindow)}
                                </span>
                              )}
                              <span className="text-[10px] font-mono text-muted/60 tabular-nums w-16 text-right">
                                {formatCost(m.costPer1kInput)}/1K
                              </span>
                            </div>
                          </button>
                        );
                      };

                      return (
                        <>
                          {/* Hoisted selected model for OpenRouter (no-search mode) */}
                          {hoistedSelected && !seenIds.has(hoistedSelected.id) && (
                            <>
                              {renderModelButton(hoistedSelected)}
                              <div className="mx-3 my-0.5 border-t border-[var(--surface-200)]" />
                            </>
                          )}

                          {/* Main model list */}
                          {modelsToRender.map(m => {
                            if (seenIds.has(m.id)) return null;
                            return renderModelButton(m);
                          })}

                          {/* Show more button for OpenRouter */}
                          {isOpenRouter && !activeSearch && remainingCount > 0 && (
                            <button
                              type="button"
                              onClick={() => setShowAllOpenRouter(true)}
                              className="w-full px-3 py-2 text-[11px] text-muted/60 hover:text-muted transition-colors text-left"
                            >
                              Show more ({remainingCount} remaining)
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
