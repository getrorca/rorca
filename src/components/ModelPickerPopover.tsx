/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, Search, Check, Zap, Clock, Turtle, Sparkles, Brain } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import type { ModelOption } from './ModelSearchSelect';
import type { EngineValue } from './EngineSelector';


// ─── Hardcoded Claude models (subscription path) ──────────────────────────────
const CLAUDE_MODELS: ModelOption[] = [
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    provider: 'Anthropic',
    providerType: 'anthropic',
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: 200000,
    speedTier: 'slow',
    costTier: 'subscription',
    recommended: false,
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high', 'max'],
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    providerType: 'anthropic',
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: 200000,
    speedTier: 'medium',
    costTier: 'subscription',
    recommended: true,
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high'],
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    providerType: 'anthropic',
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: 200000,
    speedTier: 'fast',
    costTier: 'subscription',
    recommended: false,
    supportsReasoning: true,
    effortLevels: ['low', 'medium', 'high'],
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatContext(ctx: number): string {
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
  return `${Math.round(ctx / 1000)}K`;
}

function formatCost(model: ModelOption): string {
  if (model.costTier === 'subscription' || model.providerType === 'anthropic') {
    return 'Subscription';
  }
  if (model.costPer1kInput === 0) return 'Free';
  if (model.costPer1kInput < 0.001) return `$${model.costPer1kInput.toFixed(4)}/1K`;
  return `$${model.costPer1kInput.toFixed(3)}/1K`;
}

const PI_PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  chatgpt: 'OpenAI',
  codex: 'OpenAI',
  anthropic: 'Anthropic',
  claude: 'Anthropic',
  google: 'Google',
  gemini: 'Google',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
};

function normalizePiProviderLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PI_PROVIDER_LABELS[normalized] ?? provider;
}

function mapPiModels(
  models: Array<{ provider: string; model: string; contextTokens: number; maxOutTokens: number; thinking: boolean; images: boolean }>,
  selectedModelId: string | null,
): ModelOption[] {
  return models.map((model, index) => ({
    id: model.model,
    label: model.model,
    provider: normalizePiProviderLabel(model.provider),
    providerType: 'pi',
    costPer1kInput: 0,
    costPer1kOutput: 0,
    contextWindow: model.contextTokens > 0 ? model.contextTokens : undefined,
    speedTier: undefined,
    costTier: 'free',
    recommended: selectedModelId ? model.model === selectedModelId : index === 0,
    supportsReasoning: model.thinking,
    effortLevels: model.thinking ? ['low', 'medium', 'high'] : [],
  }));
}

const SpeedIcon = ({ tier }: { tier?: string }) => {
  if (tier === 'fast') return <Zap size={11} className="text-emerald-400 shrink-0" />;
  if (tier === 'slow') return <Turtle size={11} className="text-amber-400 shrink-0" />;
  return <Clock size={11} className="text-[var(--text-muted)]/50 shrink-0" />;
};

// ─── Group building ───────────────────────────────────────────────────────────
interface ModelGroup {
  label: string;
  models: ModelOption[];
}

function buildGroups(models: ModelOption[], query: string, reasoningOnly: boolean): ModelGroup[] {
  const q = query.toLowerCase().trim();
  let filtered = q
    ? models.filter(
        m =>
          m.label.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q)
      )
    : models;

  if (reasoningOnly) {
    filtered = filtered.filter(m => m.supportsReasoning);
  }

  const recommended: ModelOption[] = [];
  const byProvider = new Map<string, ModelOption[]>();

  for (const m of filtered) {
    if (m.recommended && !q) recommended.push(m);
    const arr = byProvider.get(m.provider) ?? [];
    arr.push(m);
    byProvider.set(m.provider, arr);
  }

  const groups: ModelGroup[] = [];
  if (recommended.length > 0) {
    groups.push({ label: 'Recommended', models: recommended });
  }

  const PROVIDER_ORDER = ['Anthropic', 'OpenAI', 'Google', 'Groq', 'DeepSeek', 'Mistral', 'Together AI', 'Fireworks', 'Ollama'];
  const orderedProviders = [
    ...PROVIDER_ORDER.filter(p => byProvider.has(p)),
    ...[...byProvider.keys()].filter(p => !PROVIDER_ORDER.includes(p) && p !== 'OpenRouter'),
  ];

  for (const provider of orderedProviders) {
    const provModels = byProvider.get(provider);
    if (provModels) groups.push({ label: provider, models: provModels });
  }

  const orModels = byProvider.get('OpenRouter');
  if (orModels) groups.push({ label: 'OpenRouter', models: orModels });

  return groups;
}

// ─── Flat virtualized list item types ────────────────────────────────────────
type ListItem =
  | { type: 'header'; label: string; count: number; collapsible: boolean }
  | { type: 'model'; model: ModelOption; globalIdx: number };

function buildFlatList(groups: ModelGroup[], collapsed: Set<string>): ListItem[] {
  const items: ListItem[] = [];
  const seen = new Set<string>();
  let globalIdx = 0;

  for (const g of groups) {
    const newModels = g.models.filter(m => !seen.has(m.id));
    if (newModels.length === 0) continue;

    items.push({
      type: 'header',
      label: g.label,
      count: newModels.length,
      collapsible: g.label !== 'Recommended',
    });

    if (!collapsed.has(g.label)) {
      for (const m of newModels) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          items.push({ type: 'model', model: m, globalIdx: globalIdx++ });
        }
      }
    }
  }

  return items;
}

// ─── Props ────────────────────────────────────────────────────────────────────
export interface ModelPickerPopoverProps {
  engine: EngineValue;
  value: string;
  onChange: (modelId: string) => void;
  workspaceId?: string;
  defaultModelId?: string | null;
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function ModelPickerPopover({
  engine,
  value,
  onChange,
  workspaceId,
  defaultModelId,
}: ModelPickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(['OpenRouter']));
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [reasoningOnly, setReasoningOnly] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
    width: number;
    openUp: boolean;
  } | null>(null);

  // ── Load models ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;

    if (engine === 'claude') {
      // Mark the currently selected (or default) model as recommended
      const rec = value || defaultModelId || 'claude-sonnet-4-6';
      setModels(
        CLAUDE_MODELS.map(m => ({ ...m, recommended: m.id === rec }))
      );
      return;
    }

    if (engine === 'codex') {
      setLoading(true);
      apiFetch<{ models: Array<{ id: string; label: string; reasoningLevels: string[]; contextWindow: number | null; recommended: boolean }> }>('/api/config/codex-models')
        .then(data => {
          const rec = value || data.models[0]?.id;
          setModels(data.models.map(m => ({
            id: m.id,
            label: m.label,
            provider: 'OpenAI',
            providerType: 'openai' as const,
            costPer1kInput: 0,
            costPer1kOutput: 0,
            contextWindow: m.contextWindow ?? 200000,
            speedTier: undefined,
            costTier: 'subscription' as const,
            recommended: m.id === rec,
            supportsReasoning: m.reasoningLevels.length > 0,
          })));
        })
        .catch(() => setModels([]))
        .finally(() => setLoading(false));
      return;
    }

    if (engine === 'opencode') {
      setLoading(true);
      const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
      apiFetch<{ models: ModelOption[]; defaultModel: string }>(`/api/direction/models${qs}`)
        .then(data => {
          // OpenCode uses API keys — hide Anthropic models (those require Claude subscription)
          setModels(data.models.filter(m => m.provider !== 'Anthropic'));
        })
        .catch(() => {
          setModels([]);
        })
        .finally(() => setLoading(false));
      return;
    }

    if (engine === 'pi') {
      setLoading(true);
      apiFetch<{ models: Array<{ provider: string; model: string; contextTokens: number; maxOutTokens: number; thinking: boolean; images: boolean }> }>('/api/config/pi-models')
        .then(data => {
          setModels(mapPiModels(data.models ?? [], value || defaultModelId || null));
        })
        .catch(() => {
          setModels([]);
        })
        .finally(() => setLoading(false));
    }
  }, [open, engine, workspaceId, value, defaultModelId]);

  // ── Position calculation ───────────────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      setPopoverPos(null);
      setQuery('');
      setReasoningOnly(false);
      // For OpenCode, OpenRouter is the primary model source — start expanded
      setCollapsed(engine === 'opencode' || engine === 'codex' ? new Set() : new Set(['OpenRouter']));
      return;
    }

    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const POPOVER_H = 420;
      const POPOVER_W = 360;
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const openUp = spaceBelow < POPOVER_H && rect.top > spaceBelow;

      setPopoverPos({
        top: openUp ? rect.top - POPOVER_H - 4 : rect.bottom + 4,
        left: Math.min(rect.left, window.innerWidth - POPOVER_W - 8),
        width: POPOVER_W,
        openUp,
      });

      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // ── Auto-expand OpenRouter when model is from OpenRouter ──────────────────
  useEffect(() => {
    if (!open) return;
    const sel = models.find(m => m.id === value);
    if (sel?.provider === 'OpenRouter') {
      setCollapsed(prev => {
        if (!prev.has('OpenRouter')) return prev;
        const next = new Set(prev);
        next.delete('OpenRouter');
        return next;
      });
    }
  }, [open, value, models]);

  // ── Auto-expand groups with search matches ────────────────────────────────
  useEffect(() => {
    if (!open || !query.trim()) return;
    const q = query.toLowerCase();
    const matchedProviders = new Set(
      models
        .filter(
          m =>
            m.label.toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q)
        )
        .map(m => m.provider)
    );
    setCollapsed(prev => {
      const next = new Set(prev);
      for (const p of matchedProviders) next.delete(p);
      return next;
    });
  }, [query, open, models]);

  // ── Outside click to close ─────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        triggerRef.current && !triggerRef.current.contains(t) &&
        popoverRef.current && !popoverRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // ── Groups + flat list ─────────────────────────────────────────────────────
  const groups = useMemo(() => buildGroups(models, query, reasoningOnly), [models, query, reasoningOnly]);
  const flatList = useMemo(() => buildFlatList(groups, collapsed), [groups, collapsed]);

  // model-only flat list for keyboard navigation
  const modelItems = useMemo(
    () => flatList.filter((item): item is Extract<ListItem, { type: 'model' }> => item.type === 'model'),
    [flatList]
  );

  // ── Virtualizer ───────────────────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: flatList.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: i => (flatList[i]?.type === 'header' ? 28 : 32),
    overscan: 8,
  });

  // ── Scroll highlighted model into view ────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const item = modelItems[highlightIdx];
    if (!item) return;
    const flatIdx = flatList.indexOf(item);
    if (flatIdx >= 0) virtualizer.scrollToIndex(flatIdx, { align: 'auto' });
  }, [highlightIdx, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setHighlightIdx(0); }, [query]);

  // ── Toggle group collapse ─────────────────────────────────────────────────
  const toggleCollapsed = useCallback((label: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  // ── Select a model ────────────────────────────────────────────────────────
  const selectModel = useCallback(
    (modelId: string) => {
      onChange(modelId);
      setOpen(false);
    },
    [onChange]
  );

  // ── Keyboard navigation ───────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
          setHighlightIdx(i => Math.min(i + 1, modelItems.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightIdx(i => Math.max(i - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (modelItems[highlightIdx]) selectModel(modelItems[highlightIdx].model.id);
          break;
        case 'Escape':
          e.preventDefault();
          setOpen(false);
          break;
      }
    },
    [open, modelItems, highlightIdx, selectModel]
  );

  // ── Selected model info ────────────────────────────────────────────────────
  const selected = models.find(m => m.id === value);
  const displayLabel = selected
    ? selected.label
    : engine === 'claude'
      ? 'Claude Sonnet 4.6'
      : engine === 'codex'
        ? 'Select GPT model'
        : 'Select model';

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="relative inline-block" onKeyDown={handleKeyDown}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`
          inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded
          border text-sm transition-colors outline-none
          bg-[var(--panel)] border-[var(--border)] text-[var(--text)]
          hover:border-[var(--accent)]/50 focus:border-[var(--accent)] cursor-pointer
        `}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Pick LLM model"
      >
        <span className="truncate max-w-[160px] font-medium">{displayLabel}</span>
        {selected?.contextWindow && (
          <span className="text-[10px] font-mono text-[var(--text-muted)]/60 tabular-nums shrink-0">
            {formatContext(selected.contextWindow)}
          </span>
        )}
        <ChevronDown
          size={13}
          className={`text-[var(--text-muted)]/60 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Popover panel — fixed to escape overflow */}
      {open && popoverPos && (
        <div
          ref={popoverRef}
          role="listbox"
          aria-label="Model list"
          className="fixed z-[9999] bg-[var(--panel)] border border-[var(--border)] rounded-lg overflow-hidden flex flex-col"
          style={{
            top: popoverPos.top,
            left: popoverPos.left,
            width: popoverPos.width,
            height: 420,
            boxShadow: '0 8px 32px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.14)',
          }}
        >
          {/* Search bar */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
            <Search size={13} className="text-[var(--text-muted)]/50 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search models..."
              className="flex-1 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-muted)]/40 outline-none"
              aria-label="Search models"
            />
            {/* Reasoning filter chip */}
            <button
              type="button"
              onClick={() => setReasoningOnly(v => !v)}
              title="Show only reasoning-capable models"
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors shrink-0 ${
                reasoningOnly
                  ? 'bg-violet-500/20 text-violet-400 border border-violet-500/30'
                  : 'bg-[var(--surface-200)] text-[var(--text-muted)]/60 hover:text-[var(--text-muted)] border border-transparent'
              }`}
              aria-pressed={reasoningOnly}
            >
              <Brain size={10} />
              Reasoning
            </button>
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-[10px] text-[var(--text-muted)]/50 hover:text-[var(--text-muted)] transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {/* Loading state */}
          {loading && (
            <div className="flex-1 flex items-center justify-center">
              <span className="text-xs text-[var(--text-muted)]/60 animate-pulse">Loading models…</span>
            </div>
          )}

          {/* Empty state */}
          {!loading && flatList.length === 0 && (
            <div className="flex-1 flex items-center justify-center px-4">
              <span className="text-xs text-[var(--text-muted)]/60 text-center">
                {query ? `No models match "${query}"` : 'No models available'}
              </span>
            </div>
          )}

          {/* Virtualized model list */}
          {!loading && flatList.length > 0 && (
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
              <div
                style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
              >
                {virtualizer.getVirtualItems().map(vItem => {
                  const item = flatList[vItem.index];
                  if (!item) return null;

                  return (
                    <div
                      key={vItem.key}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vItem.start}px)`,
                      }}
                    >
                      {item.type === 'header' ? (
                        /* Group header */
                        item.collapsible ? (
                          <button
                            type="button"
                            onClick={() => toggleCollapsed(item.label)}
                            className="w-full flex items-center justify-between px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]/60 bg-[var(--bg)] hover:text-[var(--text-muted)] transition-colors cursor-pointer sticky top-0"
                          >
                            <span>{item.label}</span>
                            <span className="flex items-center gap-1 text-[9px] font-normal normal-case tracking-normal text-[var(--text-muted)]/40">
                              {collapsed.has(item.label) && `${item.count} models`}
                              <ChevronDown
                                size={9}
                                className={`transition-transform duration-150 ${collapsed.has(item.label) ? '-rotate-90' : ''}`}
                              />
                            </span>
                          </button>
                        ) : (
                          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]/60 bg-[var(--bg)] flex items-center gap-1">
                            <Sparkles size={9} className="text-amber-400 shrink-0" />
                            {item.label}
                          </div>
                        )
                      ) : (
                        /* Model row */
                        (() => {
                          const { model, globalIdx } = item;
                          const isSelected = model.id === value;
                          const isHighlighted = globalIdx === highlightIdx;
                          const isDefault = model.id === defaultModelId;
                          return (
                            <button
                              type="button"
                              role="option"
                              aria-selected={isSelected}
                              onClick={() => selectModel(model.id)}
                              onMouseEnter={() => setHighlightIdx(globalIdx)}
                              className={`w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 transition-colors ${
                                isHighlighted
                                  ? 'bg-[var(--accent)]/8 text-[var(--text)]'
                                  : 'text-[var(--text)]/80 hover:bg-[var(--surface-200)]'
                              }`}
                            >
                              {/* Check mark */}
                              <span className="w-3.5 shrink-0">
                                {isSelected && <Check size={12} className="text-[var(--accent)]" />}
                              </span>

                              {/* Label + reasoning icon + default badge */}
                              <div className="flex-1 min-w-0 flex items-center gap-1.5">
                                <span className={`truncate ${isSelected ? 'font-medium' : ''}`}>
                                  {model.label}
                                </span>
                                {model.supportsReasoning && (
                                  <span
                                    title={model.effortLevels && model.effortLevels.length > 0
                                      ? `Supports reasoning: ${model.effortLevels.join(', ')} effort`
                                      : 'Supports native reasoning'}
                                    className="shrink-0"
                                  >
                                    <Brain size={11} className="text-violet-400" />
                                  </span>
                                )}
                                {isDefault && (
                                  <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] font-medium">
                                    Default
                                  </span>
                                )}
                              </div>

                              {/* Meta: speed, context, cost */}
                              <div className="flex items-center gap-2 shrink-0">
                                <SpeedIcon tier={model.speedTier} />
                                {(model.contextWindow ?? 0) > 0 && (
                                  <span className="text-[10px] font-mono text-[var(--text-muted)]/40 tabular-nums w-8 text-right">
                                    {formatContext(model.contextWindow ?? 0)}
                                  </span>
                                )}
                                <span className="text-[10px] font-mono text-[var(--text-muted)]/60 tabular-nums w-20 text-right">
                                  {formatCost(model)}
                                </span>
                              </div>
                            </button>
                          );
                        })()
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
