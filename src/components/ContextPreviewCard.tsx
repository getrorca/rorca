/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ContextPreviewCard — US-023 pre-generation context preview shown before
 * creating a spec. Groups selected sources by section with reasons and
 * token estimates, displays graph freshness, and offers a hydration trigger
 * when the knowledge graph is missing or stale.
 *
 * Consumes two backend endpoints:
 *  - POST /api/specs/generation-context → direction layers, skills, memory, etc.
 *  - GET  /api/workspaces/{workspaceId}/hydration → graph freshness, hydration status
 */

import { useState, useEffect, useCallback } from 'react';
import {
  ChevronDown, ChevronRight, Check, X, AlertTriangle,
  Layers, Brain, Puzzle, FileText, Share2,
  FolderOpen, RefreshCw, Loader2, Search, Network,
  Clock,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

// ─── Types ─────────────────────────────────────────────────────────────

export interface ContextPreviewEntry {
  key: string;
  section: 'direction' | 'skills' | 'memory' | 'graph' | 'files' | 'schema' | 'template' | 'routing';
  label: string;
  reason: string;
  tokenEstimate: number;
  present: boolean;
  details?: string[];
}

export interface GraphFreshnessInfo {
  available: boolean;
  vertexCount: number;
  edgeCount: number;
  isStale: boolean;
  staleReason: string | null;
  gitSha: string | null;
  hydratedAt: string | null;
}

export interface HydrationAction {
  hint: 'hydrate' | 'rehydrate' | 'wait' | 'configure_hilo' | 'none';
  message: string | null;
  currentStatus: string | null;
}

export interface ContextPreviewData {
  workspaceId: string;
  brief: string;
  sections: {
    direction: ContextPreviewEntry[];
    skills: ContextPreviewEntry[];
    memory: ContextPreviewEntry[];
    graph: ContextPreviewEntry[];
    files: ContextPreviewEntry[];
    schema: ContextPreviewEntry[];
    template: ContextPreviewEntry[];
    routing: ContextPreviewEntry[];
  };
  totalTokens: number;
  tokenBudget: number;
  modelContextWindow: number;
  warnings: string[];
  graphFreshness: GraphFreshnessInfo;
  hydrationAction: HydrationAction;
  loadedAt: string;
}

// ─── API helpers ────────────────────────────────────────────────────────

async function fetchContextPreview(
  workspaceId: string,
  brief: string,
): Promise<ContextPreviewData | null> {
  const [genCtx, hydration] = await Promise.all([
    apiFetch<Record<string, unknown>>('/api/specs/generation-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, brief, agentOverride: 'pi' }),
      silent: true,
    }).catch(() => null),
    apiFetch<Record<string, unknown>>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/hydration`,
      { silent: true },
    ).catch(() => null),
  ]);

  if (!genCtx) return null;

  const ctxSummary = (genCtx as any).contextSummary ?? {};
  const dirLayers = ctxSummary.directionLayers ?? {};
  const retrieval = ctxSummary.retrieval ?? {};
  const workspaceRouting = ctxSummary.workspaceRouting ?? {};

  const sections: ContextPreviewData['sections'] = {
    direction: buildDirectionEntries(dirLayers),
    skills: buildSkillEntries(ctxSummary),
    memory: buildMemoryEntries(ctxSummary),
    graph: buildGraphEntries(retrieval, hydration),
    files: buildFileEntries(workspaceRouting, ctxSummary),
    schema: buildSchemaEntries(ctxSummary),
    template: buildTemplateEntries(ctxSummary),
    routing: buildRoutingEntries(workspaceRouting),
  };

  const warnings: string[] = [];
  const totalTokens = (ctxSummary.estimatedTokens as number) ?? 0;
  const budget = (ctxSummary.modelContextWindow as number) ?? 200000;

  if (totalTokens > budget * 0.8) {
    warnings.push(`Context is at ${Math.round((totalTokens / budget) * 100)}% of model window — generation quality may degrade`);
  }
  if (!dirLayers.l1 && !dirLayers.l2?.present && !dirLayers.l3) {
    warnings.push('No direction layers configured — spec quality may be reduced');
  }
  if (retrieval.graphHits === 0) {
    warnings.push('Knowledge graph returned no hits — code relationships won\'t inform the spec');
  }

  // Build graph freshness from hydration response
  const graphFreshness: GraphFreshnessInfo = buildGraphFreshness(hydration);
  const hydrationAction: HydrationAction = buildHydrationAction(hydration);

  return {
    workspaceId,
    brief,
    sections,
    totalTokens,
    tokenBudget: budget,
    modelContextWindow: budget,
    warnings,
    graphFreshness,
    hydrationAction,
    loadedAt: new Date().toISOString(),
  };
}

function buildDirectionEntries(dirLayers: Record<string, unknown>): ContextPreviewEntry[] {
  const entries: ContextPreviewEntry[] = [];
  for (const key of ['l1', 'l2', 'l3']) {
    const layer = (dirLayers as any)[key];
    const present = key === 'l2' ? (layer?.present === true) : (layer === true);
    const titleKey = `${key}Title`;
    const tokensKey = `${key}Tokens`;
    entries.push({
      key: `direction-${key}`,
      section: 'direction',
      label: `${key.toUpperCase()} ${(dirLayers as any)[titleKey] ?? (key === 'l1' ? 'Standards' : key === 'l2' ? 'Conventions' : 'Project')}`,
      reason: present
        ? `${key === 'l1' ? 'Global engineering standards' : key === 'l2' ? 'Domain conventions' : 'Project-specific context'}`
        : `No ${key.toUpperCase()} layer configured`,
      tokenEstimate: present ? ((dirLayers as any)[tokensKey] as number) ?? 0 : 0,
      present,
    });
  }
  return entries;
}

function buildSkillEntries(ctxSummary: Record<string, unknown>): ContextPreviewEntry[] {
  const skills = (ctxSummary.skills as string[]) ?? [];
  if (skills.length === 0) {
    return [{
      key: 'skills-none',
      section: 'skills',
      label: 'No skills matched',
      reason: 'No skills were matched for this brief',
      tokenEstimate: 0,
      present: false,
    }];
  }
  return skills.map((name) => ({
    key: `skill-${name}`,
    section: 'skills' as const,
    label: name,
    reason: `Matched skill relevant to spec brief`,
    tokenEstimate: Math.ceil(500 / skills.length), // approximate
    present: true,
  }));
}

function buildMemoryEntries(ctxSummary: Record<string, unknown>): ContextPreviewEntry[] {
  const count = (ctxSummary.memoryEntries as number) ?? 0;
  const retrieval = (ctxSummary.retrieval as Record<string, unknown>) ?? {};
  const cagHits = (retrieval.cagHits as number) ?? 0;
  const ragHits = (retrieval.ragHits as number) ?? 0;

  const entries: ContextPreviewEntry[] = [];

  if (cagHits > 0) {
    entries.push({
      key: 'memory-cag',
      section: 'memory',
      label: `Cache (CAG) — ${cagHits} hits`,
      reason: 'Direction layers, memory, and skills resolved from in-memory cache',
      tokenEstimate: Math.ceil((cagHits * 200)),
      present: true,
    });
  }

  if (ragHits > 0) {
    entries.push({
      key: 'memory-rag',
      section: 'memory',
      label: `Vector (RAG) — ${ragHits} hits`,
      reason: 'Hybrid vector+keyword search for relevant memories',
      tokenEstimate: Math.ceil((ragHits * 300)),
      present: true,
    });
  }

  if (count > 0) {
    entries.push({
      key: 'memory-count',
      section: 'memory',
      label: `${count} memory entries`,
      reason: 'Stored project memories available for context injection',
      tokenEstimate: Math.ceil(count * 150),
      present: true,
    });
  } else if (entries.length === 0) {
    entries.push({
      key: 'memory-none',
      section: 'memory',
      label: 'No memory data',
      reason: 'No memory entries or retrieval hits available',
      tokenEstimate: 0,
      present: false,
    });
  }

  return entries;
}

function buildGraphEntries(
  retrieval: Record<string, unknown>,
  _hydration: Record<string, unknown> | null,
): ContextPreviewEntry[] {
  const graphHits = (retrieval.graphHits as number) ?? null;
  const entries: ContextPreviewEntry[] = [];

  if (graphHits != null && graphHits > 0) {
    entries.push({
      key: 'graph-hits',
      section: 'graph',
      label: `${graphHits} graph node${graphHits !== 1 ? 's' : ''}`,
      reason: 'Knowledge graph nodes relevant to brief retrieved via Apache AGE',
      tokenEstimate: Math.ceil(graphHits * 250),
      present: true,
    });
  } else {
    entries.push({
      key: 'graph-none',
      section: 'graph',
      label: 'No graph hits',
      reason: 'No relevant knowledge graph nodes found — consider hydrating the graph',
      tokenEstimate: 0,
      present: false,
    });
  }

  return entries;
}

function buildFileEntries(
  routing: Record<string, unknown>,
  ctxSummary: Record<string, unknown>,
): ContextPreviewEntry[] {
  const entries: ContextPreviewEntry[] = [];
  const agentsMd = ctxSummary.agentsMd as boolean | undefined;
  const schema = ctxSummary.schemaSnapshot as boolean | undefined;
  const predictedFiles = ctxSummary.predictedFiles as string[] | undefined;

  if (agentsMd) {
    entries.push({
      key: 'file-agents-md',
      section: 'files',
      label: 'AGENTS.md',
      reason: 'Project governance file with coding conventions and rules',
      tokenEstimate: 2000,
      present: true,
    });
  }

  if (schema) {
    entries.push({
      key: 'file-schema',
      section: 'files',
      label: 'Schema snapshot',
      reason: 'Database schema used for data-aware generation',
      tokenEstimate: 1500,
      present: true,
    });
  }

  if (predictedFiles && predictedFiles.length > 0) {
    const fileTokens = Math.ceil(predictedFiles.length * 800);
    entries.push({
      key: 'file-predicted',
      section: 'files',
      label: `${predictedFiles.length} predicted files`,
      reason: 'Files likely relevant to the spec based on context routing',
      tokenEstimate: fileTokens,
      present: true,
      details: predictedFiles.slice(0, 5),
    });
  }

  const stack = (routing.stack as string[]) ?? [];
  if (stack.length > 0) {
    entries.push({
      key: 'file-stack',
      section: 'files',
      label: `Stack detected: ${stack.join(', ')}`,
      reason: 'Technology stack identified from workspace layout',
      tokenEstimate: 0,
      present: true,
    });
  }

  const missingFiles = (routing.missingContextFiles as string[]) ?? [];
  if (missingFiles.length > 0) {
    entries.push({
      key: 'files-missing',
      section: 'files',
      label: `${missingFiles.length} missing context files`,
      reason: `Recommended files not found: ${missingFiles.join(', ')}`,
      tokenEstimate: 0,
      present: false,
    });
  }

  if (entries.length === 0) {
    entries.push({
      key: 'files-none',
      section: 'files',
      label: 'No relevant files detected',
      reason: 'No project files matched the brief context',
      tokenEstimate: 0,
      present: false,
    });
  }

  return entries;
}

function buildSchemaEntries(ctxSummary: Record<string, unknown>): ContextPreviewEntry[] {
  return [{
    key: 'schema-entry',
    section: 'schema',
    label: ctxSummary.schemaSnapshot ? 'Schema snapshot available' : 'No schema snapshot',
    reason: ctxSummary.schemaSnapshot
      ? 'Database schema will be injected for data-aware spec generation'
      : 'No schema snapshot configured — generate one from workspace settings',
    tokenEstimate: ctxSummary.schemaSnapshot ? 1500 : 0,
    present: !!ctxSummary.schemaSnapshot,
  }];
}

function buildTemplateEntries(ctxSummary: Record<string, unknown>): ContextPreviewEntry[] {
  const template = ctxSummary.template as string | null | undefined;
  return [{
    key: 'template-entry',
    section: 'template',
    label: template ? `Template: ${template}` : 'No template',
    reason: template
      ? 'Story structure will follow the selected template pattern'
      : 'No template selected — stories will use default structure',
    tokenEstimate: template ? 1000 : 0,
    present: !!template,
  }];
}

function buildRoutingEntries(routing: Record<string, unknown>): ContextPreviewEntry[] {
  const richnessScore = routing.richnessScore as number | undefined;
  const entries: ContextPreviewEntry[] = [];

  if (richnessScore != null) {
    const level = richnessScore >= 7 ? 'good' : richnessScore >= 4 ? 'moderate' : 'low';
    entries.push({
      key: 'routing-richness',
      section: 'routing',
      label: `Context richness: ${level} (${richnessScore}/10)`,
      reason: richnessScore >= 7
        ? 'Workspace has good context coverage'
        : richnessScore >= 4
          ? 'Workspace has moderate context — consider adding more docs'
          : 'Low context richness — add AGENTS.md, direction layers, and docs',
      tokenEstimate: 0,
      present: true,
    });
  }

  return entries;
}

function buildGraphFreshness(hydration: Record<string, unknown> | null): GraphFreshnessInfo {
  if (!hydration) {
    return {
      available: false,
      vertexCount: 0,
      edgeCount: 0,
      isStale: true,
      staleReason: 'Unable to fetch hydration status',
      gitSha: null,
      hydratedAt: null,
    };
  }

  const latest = (hydration.latest as Record<string, unknown>) ?? {};
  const freshness = (hydration.freshness as string) ?? 'unknown';
  const counts = (hydration.counts as Record<string, number>) ?? {};
  const freshnessDetails = (hydration.freshnessDetails as Record<string, unknown>) ?? {};

  return {
    available: latest != null && (latest.status as string) === 'succeeded',
    vertexCount: counts.nodes ?? 0,
    edgeCount: counts.edges ?? 0,
    isStale: freshness !== 'clean' && freshness !== 'unknown',
    staleReason: freshness !== 'clean'
      ? (freshnessDetails.humanSummary as string) ?? 'Graph is out of date'
      : null,
    gitSha: (freshnessDetails.hydratedSha as string) ?? null,
    hydratedAt: (latest.finishedAt as string) ?? null,
  };
}

function buildHydrationAction(hydration: Record<string, unknown> | null): HydrationAction {
  if (!hydration) {
    return { hint: 'none', message: null, currentStatus: null };
  }
  return {
    hint: (hydration.actionHint as HydrationAction['hint']) ?? 'none',
    message: (hydration.actionMessage as string) ?? null,
    currentStatus: (hydration.currentStatus as string) ?? null,
  };
}

// ─── Sub-component: Token budget bar ───────────────────────────────────

function TokenBudgetBar({ total, budget, warnings }: { total: number; budget: number; warnings: string[] }) {
  const pct = Math.min(100, Math.round((total / budget) * 100));
  const hasWarnings = warnings.length > 0;

  return (
    <div className="space-y-1.5" data-testid="context-preview-token-bar">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted flex items-center gap-1">
          <Layers className="w-3 h-3" />
          Estimated tokens
        </span>
        <span className={`font-mono ${pct > 80 ? 'text-rose-400' : pct > 50 ? 'text-amber-500' : 'text-text'}`}>
          {(total / 1000).toFixed(1)}K / {(budget / 1000).toFixed(0)}K ({pct}%)
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-border overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            pct > 80 ? 'bg-red-500' : pct > 50 ? 'bg-amber-500' : 'bg-accent'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {hasWarnings && (
        <div className="space-y-1 mt-1">
          {warnings.map((w, i) => (
            <p key={i} className="text-[10px] text-amber-500 flex items-center gap-1" data-testid="context-preview-warning">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sub-component: Section group ──────────────────────────────────────

function SectionGroup({
  title,
  icon: Icon,
  entries,
  defaultExpanded,
}: {
  title: string;
  icon: typeof Layers;
  entries: ContextPreviewEntry[];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const presentCount = entries.filter(e => e.present).length;
  const sectionTokens = entries.reduce((sum, e) => sum + e.tokenEstimate, 0);

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/5 transition-colors"
        data-testid={`context-preview-section-${title.toLowerCase().replace(/\s/g, '-')}`}
        aria-expanded={expanded}
      >
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
        }
        <Icon className="w-3.5 h-3.5 text-muted shrink-0" />
        <span className="text-xs font-medium text-text">{title}</span>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted">
          <span>{presentCount}/{entries.length} active</span>
          {sectionTokens > 0 && (
            <span className="font-mono">{sectionTokens >= 1000 ? `${(sectionTokens / 1000).toFixed(1)}K` : sectionTokens} tok</span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="px-6 pb-2 space-y-1.5" data-testid={`context-preview-section-${title.toLowerCase().replace(/\s/g, '-')}-body`}>
          {entries.map(entry => (
            <div key={entry.key} className="flex items-start gap-2 py-1" data-testid={`context-preview-entry-${entry.key}`}>
              <span className="mt-0.5">
                {entry.present
                  ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                  : <X className="w-3.5 h-3.5 text-muted/50" />
                }
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`text-xs ${entry.present ? 'text-text font-medium' : 'text-muted/60'}`}>
                    {entry.label}
                  </span>
                  {entry.tokenEstimate > 0 && (
                    <span className="text-[10px] font-mono text-muted">
                      {entry.tokenEstimate >= 1000 ? `${(entry.tokenEstimate / 1000).toFixed(1)}K` : entry.tokenEstimate} tok
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-muted/70 mt-0.5">{entry.reason}</p>
                {entry.details && entry.details.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {entry.details.map((d, i) => (
                      <code key={i} className="px-1 py-0.5 text-[9px] font-mono bg-muted/10 rounded text-muted truncate max-w-[200px]">
                        {d}
                      </code>
                    ))}
                    {entry.details.length === 5 && (entry as any)._totalFiles > 5 && (
                      <span className="text-[9px] text-muted">+{(entry as any)._totalFiles - 5} more</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sub-component: Graph freshness indicator ──────────────────────────

function GraphFreshnessIndicator({
  freshness,
  action,
  onHydrate,
  hydrating,
}: {
  freshness: GraphFreshnessInfo;
  action: HydrationAction;
  onHydrate: () => void;
  hydrating: boolean;
}) {
  const canHydrate = action.hint === 'hydrate' || action.hint === 'rehydrate';
  const needsAttention = freshness.isStale || !freshness.available;

  return (
    <div
      className={`flex items-center justify-between px-3 py-2 rounded border text-xs ${
        needsAttention
          ? 'border-amber-500/30 bg-amber-500/5 text-amber-500'
          : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-500'
      }`}
      data-testid="context-preview-graph-freshness"
    >
      <div className="flex items-center gap-2">
        {needsAttention ? <Clock className="w-3.5 h-3.5 shrink-0" /> : <Check className="w-3.5 h-3.5 shrink-0" />}
        <div>
          <span className="font-medium">
            {!freshness.available
              ? 'Knowledge graph unavailable'
              : freshness.isStale
                ? 'Knowledge graph is stale'
                : 'Knowledge graph up to date'}
          </span>
          {freshness.available && (
            <span className="ml-2 text-[10px] opacity-70">
              {freshness.vertexCount} nodes, {freshness.edgeCount} edges
            </span>
          )}
          {freshness.staleReason && (
            <p className="text-[10px] opacity-70 mt-0.5">{freshness.staleReason}</p>
          )}
        </div>
      </div>
      {canHydrate && (
        <button
          onClick={onHydrate}
          disabled={hydrating}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
            hydrating
              ? 'bg-border/50 text-muted cursor-not-allowed'
              : 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
          }`}
          data-testid="context-preview-hydrate-btn"
        >
          {hydrating ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          {hydrating ? 'Hydrating…' : action.hint === 'rehydrate' ? 'Re-hydrate' : 'Hydrate'}
        </button>
      )}
      {action.hint === 'configure_hilo' && (
        <span
          className="px-2 py-1 text-[10px] rounded bg-muted/15 text-muted"
          data-testid="context-preview-hilo-missing"
        >
          Hilo not configured
        </span>
      )}
      {action.currentStatus === 'running' && (
        <span className="flex items-center gap-1.5 px-2 py-1 text-[10px] rounded bg-accent/15 text-accent">
          <Loader2 size={10} className="animate-spin" />
          Hydrating…
        </span>
      )}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────

interface ContextPreviewCardProps {
  workspaceId: string;
  brief: string;
}

export default function ContextPreviewCard({ workspaceId, brief }: ContextPreviewCardProps) {
  const [data, setData] = useState<ContextPreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hydrating, setHydrating] = useState(false);

  const fetchPreview = useCallback(async () => {
    if (!workspaceId || !brief.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchContextPreview(workspaceId, brief.trim());
      setData(result);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load context preview');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, brief]);

  useEffect(() => {
    if (expanded && !data && !loading && !error) {
      fetchPreview();
    }
  }, [expanded, data, loading, error, fetchPreview]);

  const handleHydrate = useCallback(async () => {
    if (!workspaceId) return;
    setHydrating(true);
    try {
      await apiFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/hydration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ types: ['hilo'] }),
      });
      // Re-fetch after a short delay
      setTimeout(() => {
        fetchPreview().finally(() => setHydrating(false));
      }, 3000);
    } catch {
      setHydrating(false);
    }
  }, [workspaceId, fetchPreview]);

  return (
    <div
      className="border border-border rounded-lg bg-panel overflow-hidden"
      data-testid="context-preview-card"
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/5 transition-colors"
        aria-expanded={expanded}
        data-testid="context-preview-toggle"
      >
        {expanded
          ? <ChevronDown className="w-4 h-4 text-muted shrink-0" />
          : <ChevronRight className="w-4 h-4 text-muted shrink-0" />
        }
        <Search className="w-4 h-4 text-accent shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">
          Context Preview
        </span>
        {!expanded && data && (
          <span className="ml-auto text-[10px] text-muted">
            {data.totalTokens >= 1000 ? `${(data.totalTokens / 1000).toFixed(1)}K` : data.totalTokens} tok
            {data.warnings.length > 0 && (
              <span className="ml-1 text-amber-500">({data.warnings.length} warning{data.warnings.length !== 1 ? 's' : ''})</span>
            )}
          </span>
        )}
        {!expanded && loading && (
          <Loader2 size={12} className="ml-auto animate-spin text-muted" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/50" data-testid="context-preview-body">
          {/* Loading state */}
          {loading && !data && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted" data-testid="context-preview-loading">
              <Loader2 size={14} className="animate-spin" />
              Loading context preview…
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="flex items-start gap-2 p-3 text-xs text-rose-400 bg-rose-500/5 m-3 rounded border border-rose-500/20" data-testid="context-preview-error">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Could not load context preview</p>
                <p className="text-[11px] opacity-80 mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {/* Empty state: no data yet */}
          {!data && !loading && !error && (
            <div className="px-3 py-4 text-center text-xs text-muted" data-testid="context-preview-empty">
              <p>Click the header to load context preview.</p>
            </div>
          )}

          {/* Data loaded */}
          {data && !loading && (
            <div className="space-y-0">
              {/* Graph freshness + hydration */}
              <div className="px-3 pt-3 pb-2">
                <GraphFreshnessIndicator
                  freshness={data.graphFreshness}
                  action={data.hydrationAction}
                  onHydrate={handleHydrate}
                  hydrating={hydrating}
                />
              </div>

              {/* Sections */}
              <SectionGroup
                title="Direction Layers"
                icon={Layers}
                entries={data.sections.direction}
                defaultExpanded
              />
              <SectionGroup
                title="Skills"
                icon={Puzzle}
                entries={data.sections.skills}
              />
              <SectionGroup
                title="Memory & Retrieval"
                icon={Brain}
                entries={data.sections.memory}
              />
              <SectionGroup
                title="Knowledge Graph"
                icon={Share2}
                entries={data.sections.graph}
              />
              <SectionGroup
                title="Context Files"
                icon={FolderOpen}
                entries={data.sections.files}
              />
              <SectionGroup
                title="Schema"
                icon={FileText}
                entries={data.sections.schema}
              />
              <SectionGroup
                title="Template"
                icon={FileText}
                entries={data.sections.template}
              />
              {data.sections.routing.length > 0 && (
                <SectionGroup
                  title="Workspace Richness"
                  icon={Network}
                  entries={data.sections.routing}
                />
              )}

              {/* Token budget bar */}
              <div className="px-3 py-3 border-t border-border">
                <TokenBudgetBar
                  total={data.totalTokens}
                  budget={data.tokenBudget}
                  warnings={data.warnings}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
