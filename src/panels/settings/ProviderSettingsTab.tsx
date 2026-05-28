/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Key, Save, Loader2, Trash2, Plus, Check, AlertTriangle, Zap, Globe, CheckCircle2, XCircle, Cpu, BookOpen, SlidersHorizontal, Search, Database, RefreshCw, ChevronDown, ChevronRight, Lock, Terminal, GitBranch, X, Brain, Copy } from 'lucide-react';
import { Github } from '../../components/icons/GithubIcon';
import { type EffortLevel } from '../../components/ThinkingControls';
import { ProBadge } from '../../components/UpgradePrompt';
import { useAuth } from '../../contexts/AuthContext';
import ModelSearchSelect, { type ModelOption } from '../../components/ModelSearchSelect';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useTheme, type ThemeMode } from '../../contexts/ThemeContext';
import { apiFetch } from '../../lib/apiFetch';
import { useGlobalToast } from '../../contexts/ToastContext';
import SlideOver from '../../components/SlideOver';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ApiKeyEntry {
  id: string;
  provider: string;
  label: string;
  masked_key: string;
  base_url: string | null;
  spend_total_usd: number;
  last_used_at: string | null;
  created_at: string;
}

interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  hasKey: boolean;
  baseUrl: string | null;
}

interface ReasoningModelDefault {
  override: 'auto' | 'force-on' | 'force-off';
  effort: EffortLevel;
}

interface ReasoningDefaults {
  globalAutoEnable: boolean;
  models: Record<string, ReasoningModelDefault>;
}

interface DisplaySettings {
  defaultModel: string;
  itemsPerPage: number;
  reasoningDefaults?: ReasoningDefaults;
}

interface DisplayModelOption {
  id: string;
  label: string;
  provider: string;
  providerType: string;
  costPer1kInput: number;
  costPer1kOutput: number;
  contextWindow: number;
  speedTier: 'fast' | 'medium' | 'slow';
  costTier: 'free' | 'low' | 'medium' | 'high' | 'premium';
  recommended: boolean;
  available?: boolean;
  availabilityNote?: string | null;
}

interface ModelTestResult {
  modelId: string;
  ok: boolean;
  latencyMs?: number;
  response?: string;
  error?: string;
}

interface AgentConfig {
  agentType: 'claude' | 'opencode' | 'codex' | 'pi';
  agentModel: string | null;
  opencodeInstalled: boolean | null;
  opencodeVersion: string | null;
  codexInstalled: boolean | null;
  codexVersion: string | null;
  piInstalled: boolean | null;
  piVersion: string | null;
  copilotConnected: boolean;
  copilotUsername: string | null;
}

interface OllamaStatus {
  available: boolean;
  models: Array<{ id: string; name: string; size: number; parameterSize: string }>;
  error?: string;
}

interface ClaudeAuthState {
  connected: boolean;
  email?: string;
  tier?: string;
  expiresAt?: number;
  cliInstalled: boolean;
  cliVersion?: string;
}

interface HealthResponse {
  piInstalled?: boolean;
  piVersion?: string | null;
}

interface PiModel {
  provider: string;
  model: string;
  contextTokens: number;
  maxOutTokens: number;
  thinking: boolean;
  images: boolean;
}

interface PiModelsResponse {
  models: PiModel[];
  count: number;
  piBinPath: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'claude-cli': 'Uses your Claude subscription via the claude CLI. No API key needed.',
  'anthropic': 'Direct API access to Claude models. Requires an Anthropic API key.',
  'openai-compat': 'Any OpenAI-compatible endpoint (OpenAI, Groq, Together, DeepSeek, Ollama, etc.).',
  'openrouter': 'Access 200+ models through a single API key. Configure in Execution Engine above.',
};

const SPEED_LABELS: Record<string, { label: string; color: string }> = {
  fast: { label: 'Fast', color: 'text-green-500' },
  medium: { label: 'Medium', color: 'text-amber-500' },
  slow: { label: 'Slow', color: 'text-red-400' },
};

const COST_LABELS: Record<string, { label: string; color: string }> = {
  free: { label: 'Free', color: 'text-green-500' },
  low: { label: 'Low', color: 'text-green-400' },
  medium: { label: 'Medium', color: 'text-amber-500' },
  high: { label: 'High', color: 'text-orange-500' },
  premium: { label: 'Premium', color: 'text-red-400' },
};

const PI_INSTALL_COMMANDS = {
  npm: 'npm install -g @mariozechner/pi-coding-agent',
  pnpm: 'pnpm add -g @mariozechner/pi-coding-agent',
  bun: 'bun add -g @mariozechner/pi-coding-agent',
  curl: 'curl -fsSL https://pi.mariozechner.com/install.sh | sh',
} as const;

// ─── Toggle Switch ───────────────────────────────────────────────────────────

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative w-9 h-5 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-border'
        }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-switch-knob transition-transform ${checked ? 'left-[18px]' : 'left-0.5'
          }`}
      />
    </button>
  );
}

// ─── Status Bar ──────────────────────────────────────────────────────────────

interface StatusBarData {
  agentType: 'claude' | 'opencode' | 'codex' | 'pi' | null;
  agentModel: string | null;
  defaultModel: string | null;
  embeddingProvider: string | null;
  vectorCount: number | null;
  keyCount: number | null;
}

function StatusBar() {
  const toast = useGlobalToast();
  const [data, setData] = useState<StatusBarData>({
    agentType: null, agentModel: null, defaultModel: null,
    embeddingProvider: null, vectorCount: null, keyCount: null,
  });
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);

  useEffect(() => {
    Promise.allSettled([
      apiFetch<AgentConfig>('/api/config'),
      apiFetch<DisplaySettings>('/api/settings/display'),
      apiFetch<EmbeddingProviderStatus>('/api/config/embedding-provider'),
      apiFetch<EmbedAllStatus>('/api/admin/embed-all/status'),
      apiFetch<{ keys: ApiKeyEntry[] }>('/api/vault/keys'),
    ]).then(([agentRes, displayRes, embedProvRes, embedStatusRes, keysRes]) => {
      setData({
        agentType: agentRes.status === 'fulfilled' ? agentRes.value.agentType : null,
        agentModel: agentRes.status === 'fulfilled' ? agentRes.value.agentModel : null,
        defaultModel: displayRes.status === 'fulfilled' ? displayRes.value.defaultModel : null,
        embeddingProvider: embedProvRes.status === 'fulfilled' ? embedProvRes.value.provider : null,
        vectorCount: embedStatusRes.status === 'fulfilled' ? (embedStatusRes.value.embeddingCount ?? null) : null,
        keyCount: keysRes.status === 'fulfilled' ? keysRes.value.keys.length : null,
      });
    }).finally(() => setLoading(false));
  }, []);

  const handleRebuild = async () => {
    setRebuilding(true);
    try {
      const result = await apiFetch<{ queued: number }>('/api/admin/embed-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      toast.show(`Rebuild started — ${result.queued} items queued`, 'success');
    } catch (err: any) {
      toast.show(err.message || 'Failed to start rebuild', 'error');
    } finally {
      setRebuilding(false);
    }
  };

  const agentDotColor = data.agentType === 'claude'
    ? 'bg-green-500'
    : data.agentType === 'opencode'
    ? 'bg-orange-400'
    : data.agentType === 'codex'
    ? 'bg-blue-400'
    : data.agentType === 'pi'
    ? 'bg-emerald-400'
    : 'bg-zinc-500';

  const agentLabel = data.agentType === 'claude'
    ? 'Claude'
    : data.agentType === 'opencode'
    ? 'OpenCode'
    : data.agentType === 'codex'
    ? 'Codex'
    : data.agentType === 'pi'
    ? 'Pi'
    : '—';

  const pillClass = 'flex items-center gap-1.5 text-xs text-muted bg-panel border border-border rounded-full px-2.5 py-1';
  const skeletonClass = 'animate-pulse bg-border rounded-full w-24 h-5';

  return (
    <div className="flex items-center justify-between gap-4 px-1 py-3 mb-2">
      <div className="flex items-center gap-3 flex-wrap">
        {loading ? (
          <>
            <div className={skeletonClass} />
            <div className={skeletonClass} />
            <div className={skeletonClass} />
            <div className={skeletonClass} />
          </>
        ) : (
          <>
            {/* Agent pill */}
            <span className={pillClass}>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${agentDotColor}`} />
              {agentLabel}
            </span>

            {/* Model pill */}
            {data.defaultModel && (
              <span className={pillClass}>
                <Cpu size={12} className="flex-shrink-0" />
                {data.defaultModel}
              </span>
            )}

            {/* Embeddings pill */}
            {data.embeddingProvider && (
              <span className={pillClass}>
                <Database size={12} className="flex-shrink-0" />
                {data.vectorCount !== null
                  ? `${data.embeddingProvider} · ${data.vectorCount} vectors`
                  : data.embeddingProvider}
              </span>
            )}

            {/* API keys pill */}
            {data.keyCount !== null && (
              <span className={pillClass}>
                <Key size={12} className="flex-shrink-0" />
                {data.keyCount} {data.keyCount === 1 ? 'key' : 'keys'}
              </span>
            )}
          </>
        )}
      </div>

      {/* Rebuild Embeddings */}
      <button
        onClick={handleRebuild}
        disabled={rebuilding}
        className="text-xs text-muted hover:text-[var(--text)] flex items-center gap-1.5 transition-colors disabled:opacity-50 flex-shrink-0"
      >
        <RefreshCw size={12} className={rebuilding ? 'animate-spin' : ''} />
        Rebuild Embeddings
      </button>
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

const PROVIDER_TABS = [
  { id: 'connections', label: 'Connections' },
  { id: 'workflow-router', label: 'Workflow Router' },
  { id: 'model-browser', label: 'Model Browser' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'routing', label: 'Routing' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'display', label: 'Display' },
] as const;

type ProviderTabId = typeof PROVIDER_TABS[number]['id'];

export function ProviderSettingsTab() {
  const [activeTab, setActiveTab] = useState<ProviderTabId>('connections');

  // Refs for each scrollable section. 'embeddings' maps to the same DOM node as 'connections'
  // (they share a card row), so clicking Embeddings tab scrolls to top of that grid.
  const sectionRefs = useRef<Record<ProviderTabId, HTMLDivElement | null>>({
    'connections': null,
    'workflow-router': null,
    'model-browser': null,
    'embeddings': null,
    'routing': null,
    'reasoning': null,
    'display': null,
  });

  const scrollToSection = (id: ProviderTabId) => {
    setActiveTab(id);
    // 'embeddings' and 'connections' share the same card row — scroll to connections ref
    const targetId: ProviderTabId = id === 'embeddings' ? 'connections' : id;
    sectionRefs.current[targetId]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    const observers: IntersectionObserver[] = [];
    const visibilityMap: Record<string, number> = {};

    // Observe the 5 distinct DOM sections (embeddings shares connections' ref)
    const observedTabs: ProviderTabId[] = ['connections', 'workflow-router', 'model-browser', 'routing', 'reasoning', 'display'];
    observedTabs.forEach((id) => {
      const el = sectionRefs.current[id];
      if (!el) return;
      const obs = new IntersectionObserver(
        ([entry]) => {
          visibilityMap[id] = entry.intersectionRatio;
          const mostVisible = Object.entries(visibilityMap).reduce(
            (best, [k, v]) => (v > best[1] ? [k, v] : best),
            ['connections', 0] as [string, number]
          );
          if (mostVisible[1] > 0) setActiveTab(mostVisible[0] as ProviderTabId);
        },
        { threshold: 0.3, rootMargin: '-10% 0px -60% 0px' }
      );
      obs.observe(el);
      observers.push(obs);
    });

    return () => observers.forEach(o => o.disconnect());
  }, []);

  return (
    <div className="w-full min-w-0">
      {/* (1) Status bar */}
      <StatusBar />

      {/* (2) Sticky section tab nav */}
      <div
        className="sticky top-0 z-10 border-b border-border overflow-x-auto scrollbar-none"
        style={{ background: 'var(--bg)' }}
      >
        <div className="flex min-w-max">
          {PROVIDER_TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => scrollToSection(id)}
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                activeTab === id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Section cards — use the available width aggressively on large screens */}
      <div className="space-y-5 pt-4">
        {/* (1) Connections Hub + Embeddings side-by-side grid */}
        <div
          ref={el => {
            sectionRefs.current['connections'] = el;
            // 'embeddings' tab maps to this same row
            sectionRefs.current['embeddings'] = el;
          }}
          className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start"
        >
          {/* Connections Hub card */}
          <div className="min-w-0 xl:col-span-7 2xl:col-span-8">
            <ConnectionsHubSection />
          </div>

          {/* Embeddings / Semantic Engine card */}
          <div className="min-w-0 xl:col-span-5 2xl:col-span-4 rounded-xl border border-border bg-panel p-5">
            <div className="flex items-center gap-2 mb-4">
              <Database size={15} className="text-accent flex-shrink-0" />
              <span className="text-sm font-semibold text-[var(--text)]">Semantic Engine</span>
            </div>
            <SemanticEngineSection />
          </div>
        </div>

        {/* (2) Workflow Router */}
        <div ref={el => { sectionRefs.current['workflow-router'] = el; }}>
          <WorkflowRouterSection />
        </div>

        {/* (3) Model Browser */}
        <div ref={el => { sectionRefs.current['model-browser'] = el; }}>
          <ModelBrowserContainer />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
          {/* (4) Reasoning Defaults card */}
          <div ref={el => { sectionRefs.current['reasoning'] = el; }} className="min-w-0 xl:col-span-8 2xl:col-span-9">
            <ReasoningDefaultsSection />
          </div>

          {/* (6) Display card */}
          <div ref={el => { sectionRefs.current['display'] = el; }} className="min-w-0 xl:col-span-4 2xl:col-span-3">
            <DisplaySection />
          </div>
        </div>
      </div>
    </div>
  );
}


// ─── Semantic Engine Section (SE-010) ────────────────────────────────────────

type EmbeddingProviderOption = 'auto' | 'openai' | 'openrouter' | 'google' | 'voyage' | 'local';

interface EmbeddingProviderStatus {
  provider: string;
  model: string;
  dimensions: number;
  source: 'config' | 'env' | 'vault' | 'local';
}

interface EmbedAllStatus {
  running: boolean;
  queueDepth: number;
  processed: number;
  failed: number;
  embeddingCount: number;
  specCount: number;
  storyCount: number;
  memoryCount: number;
}

interface GraphStats {
  available: boolean;
  vertexCount: number;
  edgeCount: number;
  labels: string[];
}

const EMBEDDING_PROVIDERS: Array<{ value: EmbeddingProviderOption; label: string; description: string }> = [
  { value: 'auto', label: 'Auto-detect (recommended)', description: 'Automatically selects the best available provider from vault keys and env vars' },
  { value: 'openai', label: 'OpenAI (text-embedding-3-small)', description: 'High quality, 1536 dimensions' },
  { value: 'openrouter', label: 'OpenRouter (via existing key)', description: 'Uses your existing OpenRouter API key' },
  { value: 'google', label: 'Google (text-embedding-004, free tier)', description: 'Free tier available, 768 dimensions' },
  { value: 'voyage', label: 'Voyage (voyage-3)', description: 'Specialized for code and retrieval' },
  { value: 'local', label: 'Local only (TF-IDF, no API key — limited)', description: 'No API key required, keyword-based matching only' },
];

function SemanticEngineSection() {
  const toast = useGlobalToast();
  const [status, setStatus] = useState<EmbeddingProviderStatus | null>(null);
  const [embedStatus, setEmbedStatus] = useState<EmbedAllStatus | null>(null);
  const [graphStats, setGraphStats] = useState<GraphStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState<EmbeddingProviderOption>('auto');
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showStats, setShowStats] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [providerData, embedData] = await Promise.all([
        apiFetch<EmbeddingProviderStatus>('/api/config/embedding-provider'),
        apiFetch<EmbedAllStatus>('/api/admin/embed-all/status'),
      ]);
      setStatus(providerData);
      setEmbedStatus(embedData);

      // Map provider name back to selection value
      const nameToValue: Record<string, EmbeddingProviderOption> = {
        openai: 'openai', 'openai-large': 'openai',
        openrouter: 'openrouter', google: 'google',
        voyage: 'voyage', local: 'local',
      };
      if (providerData.source === 'config') {
        setSelectedProvider(nameToValue[providerData.provider] ?? 'auto');
      } else {
        setSelectedProvider('auto');
      }
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleProviderChange = async (value: EmbeddingProviderOption) => {
    setSelectedProvider(value);
    setSaving(true);
    try {
      const result = await apiFetch<EmbeddingProviderStatus>('/api/config/embedding-provider', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: value }),
      });
      setStatus(result);
      toast.show(`Embedding provider set to ${result.provider}`, 'success');
    } catch (err: any) {
      toast.show(err.message || 'Failed to update provider', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRebuild = async () => {
    setShowConfirm(false);
    setRebuilding(true);
    try {
      const result = await apiFetch<{ queued: number; skippedStale: number }>('/api/admin/embed-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      toast.show(`Rebuild started — ${result.queued} items queued`, 'success');
      // Re-fetch status after a delay
      setTimeout(() => fetchAll(), 2000);
    } catch (err: any) {
      const msg = err.message || 'Failed to start rebuild';
      toast.show(msg, 'error');
    } finally {
      setRebuilding(false);
    }
  };

  const handleViewStats = async () => {
    if (showStats) {
      setShowStats(false);
      return;
    }
    try {
      const stats = await apiFetch<GraphStats>('/api/admin/graph-stats');
      setGraphStats(stats);
    } catch { /* silent */ }
    setShowStats(true);
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading semantic engine config...</div>;
  }

  // Determine if selected provider has a key configured
  const _providerHasKey = status && (
    status.source !== 'local' ||
    selectedProvider === 'auto' ||
    selectedProvider === 'local'
  );
  const showKeyWarning = selectedProvider !== 'auto' && selectedProvider !== 'local' && status?.provider === 'local';

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted">
        Vector embeddings power semantic search, memory recall, and knowledge graph features
      </p>

      {/* Provider radio buttons */}
      <div className="space-y-1.5">
        {EMBEDDING_PROVIDERS.map(p => (
          <label
            key={p.value}
            className={`flex items-start gap-3 px-3 py-2.5 rounded border cursor-pointer transition-colors ${
              selectedProvider === p.value
                ? 'border-accent/40 bg-accent/5'
                : 'border-border bg-bg hover:border-accent/20'
            }`}
          >
            <input
              type="radio"
              name="embedding-provider"
              value={p.value}
              checked={selectedProvider === p.value}
              onChange={() => handleProviderChange(p.value)}
              disabled={saving}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <div className="min-w-0">
              <span className="text-sm text-[var(--text)]">{p.label}</span>
              <p className="text-[11px] text-muted mt-0.5">{p.description}</p>
            </div>
          </label>
        ))}
      </div>

      {/* Saving indicator */}
      {saving && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 size={12} className="animate-spin" /> Updating provider...
        </div>
      )}

      {/* Warning: no API key */}
      {showKeyWarning && (
        <div className="flex items-center gap-2 px-3 py-2 rounded text-xs bg-amber-500/10 border border-amber-500/20 text-amber-400">
          <AlertTriangle size={14} />
          {selectedProvider.charAt(0).toUpperCase() + selectedProvider.slice(1)} selected but no API key found — using local TF-IDF fallback
        </div>
      )}

      {/* Status line */}
      {status && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded border border-border bg-bg">
          <div className={`w-2 h-2 rounded-full shrink-0 ${status.provider === 'local' ? 'bg-zinc-500' : 'bg-green-500'}`} />
          <span className="text-xs text-[var(--text)]">
            <span className="font-medium capitalize">{status.provider}</span> active
            <span className="text-muted"> ({status.model}, {status.dimensions}d)</span>
            <span className="text-muted"> — via {status.source}</span>
          </span>
        </div>
      )}

      {/* Vector counts */}
      {embedStatus && (
        <div className="px-3 py-2.5 rounded border border-border bg-bg">
          <div className="flex items-center gap-1.5 text-xs text-[var(--text)]">
            <span className="font-mono font-medium">{embedStatus.embeddingCount.toLocaleString()}</span>
            <span className="text-muted">vectors</span>
            <span className="text-muted mx-1">·</span>
            <span className="font-mono">{embedStatus.specCount}</span>
            <span className="text-muted">specs</span>
            <span className="text-muted mx-1">·</span>
            <span className="font-mono">{embedStatus.storyCount}</span>
            <span className="text-muted">stories</span>
            <span className="text-muted mx-1">·</span>
            <span className="font-mono">{embedStatus.memoryCount}</span>
            <span className="text-muted">memories</span>
          </div>
          {embedStatus.running && (
            <div className="flex items-center gap-2 mt-2 text-[11px] text-amber-400">
              <Loader2 size={12} className="animate-spin" />
              Embedding job in progress ({embedStatus.processed} processed, {embedStatus.queueDepth} queued)
            </div>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setShowConfirm(true)}
          disabled={rebuilding}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {rebuilding ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Rebuild All Embeddings
        </button>
        <button
          onClick={handleViewStats}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-border rounded text-[var(--text)] hover:border-accent/40 transition-colors"
        >
          {showStats ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          View Stats
        </button>
      </div>

      {/* Confirmation dialog */}
      {showConfirm && (
        <div className="border border-amber-500/30 rounded p-4 bg-amber-500/5 space-y-3">
          <p className="text-sm text-[var(--text)]">
            This will re-embed all content with the selected provider. Existing embeddings from other providers will be replaced. Continue?
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleRebuild}
              className="flex items-center gap-2 px-4 py-1.5 text-xs bg-amber-500 text-white rounded hover:bg-amber-500/90 transition-colors"
            >
              <RefreshCw size={12} />
              Yes, Rebuild
            </button>
            <button
              onClick={() => setShowConfirm(false)}
              className="px-4 py-1.5 text-xs text-muted hover:text-[var(--text)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Graph stats expandable */}
      {showStats && (
        <div className="border border-border rounded p-4 bg-bg space-y-2">
          <h3 className="text-xs font-semibold text-[var(--text)]">Knowledge Graph Statistics</h3>
          {graphStats ? (
            graphStats.available ? (
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center gap-3">
                  <span className="text-muted">Vertices:</span>
                  <span className="font-mono text-[var(--text)]">{graphStats.vertexCount.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-muted">Edges:</span>
                  <span className="font-mono text-[var(--text)]">{graphStats.edgeCount.toLocaleString()}</span>
                </div>
                {graphStats.labels.length > 0 && (
                  <div className="flex items-center gap-3">
                    <span className="text-muted">Labels:</span>
                    <span className="text-[var(--text)]">{graphStats.labels.join(', ')}</span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted">Apache AGE extension not available — graph features disabled</p>
            )
          ) : (
            <p className="text-xs text-muted">No graph stats available</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Connections Hub (WR-009) ───────────────────────────────────────────────

interface ConnectionCardProps {
  icon: React.ReactNode;
  name: string;
  description: string;
  statusDot: 'green' | 'amber' | 'grey';
  statusLabel: string;
  maskedKey?: string;
  keyId?: string;
  showAddKey?: boolean;
  addKeyPlaceholder?: string;
  showBaseUrl?: boolean;
  baseUrlPlaceholder?: string;
  baseUrlValue?: string;
  onAddKey?: (key: string, label: string, baseUrl?: string) => Promise<void>;
  onRemoveKey?: (id: string) => Promise<void>;
  onTestConnection?: () => Promise<void>;
  testResult?: { ok: boolean; latencyMs?: number; error?: string } | null;
  testingConnection?: boolean;
  children?: React.ReactNode;
}

function ConnectionCard({
  icon, name, description, statusDot, statusLabel,
  maskedKey, keyId, showAddKey, addKeyPlaceholder, showBaseUrl, baseUrlPlaceholder, baseUrlValue,
  onAddKey, onRemoveKey, onTestConnection, testResult, testingConnection,
  children,
}: ConnectionCardProps) {
  const [addingKey, setAddingKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState(baseUrlValue || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const dotClass = statusDot === 'green' ? 'bg-green-500' : statusDot === 'amber' ? 'bg-amber-400' : 'bg-zinc-500';

  const handleSave = async () => {
    if (!onAddKey || !keyInput) return;
    setSaving(true);
    setError(null);
    try {
      await onAddKey(keyInput, labelInput, showBaseUrl ? baseUrlInput : undefined);
      setKeyInput('');
      setLabelInput('');
      setBaseUrlInput('');
      setAddingKey(false);
    } catch (err: any) {
      setError(err.message || 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!onRemoveKey || !keyId) return;
    await onRemoveKey(keyId);
    setConfirmRemove(false);
  };

  return (
    <div className="rounded-xl border border-border bg-panel p-4">
      {/* Header row */}
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-muted shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--text)]">{name}</span>
            <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
            <span className="text-xs text-muted truncate">{statusLabel}</span>
          </div>
          <p className="text-[11px] text-muted mt-0.5">{description}</p>
        </div>
        {/* Action buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          {onTestConnection && statusDot !== 'grey' && (
            <button
              onClick={onTestConnection}
              disabled={testingConnection}
              className="flex items-center gap-1 px-2 py-1 text-[11px] border border-border rounded hover:border-accent/40 text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50"
            >
              {testingConnection ? <Loader2 size={10} className="animate-spin" /> : <Globe size={10} />}
              Test
            </button>
          )}
          {showAddKey && !maskedKey && onAddKey && (
            <button
              onClick={() => setAddingKey(!addingKey)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] bg-accent text-white rounded hover:bg-accent/90 transition-colors"
            >
              <Plus size={10} /> Add Key
            </button>
          )}
          {maskedKey && keyId && onRemoveKey && (
            <button
              onClick={() => setConfirmRemove(!confirmRemove)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] border border-red-500/30 text-red-400 rounded hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={10} /> Remove
            </button>
          )}
          {showAddKey && maskedKey && onAddKey && (
            <button
              onClick={() => setAddingKey(!addingKey)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] border border-border rounded text-muted hover:text-[var(--text)] hover:border-accent/40 transition-colors"
            >
              <Key size={10} /> Replace
            </button>
          )}
        </div>
      </div>

      {/* Masked key display */}
      {maskedKey && (
        <div className="mt-2 ml-7 flex items-center gap-2 text-xs">
          <Lock size={10} className="text-muted" />
          <span className="font-mono text-muted">{maskedKey}</span>
          <span className="text-[10px] text-muted">AES-256-GCM</span>
        </div>
      )}

      {/* Test result */}
      {testResult && (
        <div className={`mt-2 ml-7 px-2.5 py-1.5 rounded text-[11px] flex items-center gap-1.5 ${
          testResult.ok
            ? 'bg-green-500/10 border border-green-500/20 text-green-400'
            : 'bg-red-500/10 border border-red-500/20 text-red-400'
        }`}>
          {testResult.ok ? (
            <><CheckCircle2 size={12} /> Connected ({testResult.latencyMs}ms)</>
          ) : (
            <><XCircle size={12} /> {testResult.error}</>
          )}
        </div>
      )}

      {/* Remove confirmation */}
      {confirmRemove && (
        <div className="mt-2 ml-7 flex items-center gap-2">
          <span className="text-xs text-red-400">Remove this key?</span>
          <button
            onClick={handleRemove}
            className="px-2 py-0.5 text-[11px] bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors"
          >
            Confirm
          </button>
          <button
            onClick={() => setConfirmRemove(false)}
            className="px-2 py-0.5 text-[11px] text-muted hover:text-[var(--text)] transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Inline add key form */}
      {addingKey && (
        <div className="mt-3 ml-7 border border-border rounded p-3 space-y-2 bg-bg">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] text-muted mb-1">API Key</label>
              <input
                type="password"
                value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                placeholder={addKeyPlaceholder || 'sk-...'}
                className="w-full px-2 py-1.5 text-xs bg-panel border border-border rounded focus:border-accent outline-none font-mono"
              />
            </div>
            <div>
              <label className="block text-[10px] text-muted mb-1">Label (optional)</label>
              <input
                type="text"
                value={labelInput}
                onChange={e => setLabelInput(e.target.value)}
                placeholder="e.g. Personal"
                className="w-full px-2 py-1.5 text-xs bg-panel border border-border rounded focus:border-accent outline-none"
              />
            </div>
          </div>
          {showBaseUrl && (
            <div>
              <label className="block text-[10px] text-muted mb-1">Base URL</label>
              <input
                type="url"
                value={baseUrlInput}
                onChange={e => setBaseUrlInput(e.target.value)}
                placeholder={baseUrlPlaceholder || 'https://api.openai.com/v1'}
                className="w-full px-2 py-1.5 text-xs bg-panel border border-border rounded focus:border-accent outline-none font-mono"
              />
            </div>
          )}
          {error && <p className="text-[11px] text-red-500">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !keyInput}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
              Save
            </button>
            <button
              onClick={() => { setAddingKey(false); setError(null); }}
              className="px-2.5 py-1 text-[11px] text-muted hover:text-[var(--text)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Optional extra content (e.g. Ollama models list) */}
      {children}
    </div>
  );
}

function ConnectionsHubSection() {
  const toast = useGlobalToast();
  const { workspaceId } = useWorkspace();

  // ── State ──────────────────────────────────────────────────────────────────
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [claudeAuth, setClaudeAuth] = useState<ClaudeAuthState | null>(null);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [openrouterViaEnv, setOpenrouterViaEnv] = useState(false);
  const [loading, setLoading] = useState(true);

  // Test connection state
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; latencyMs?: number; error?: string }>>({});

  const fetchData = useCallback(async () => {
    try {
      const [keyData, config, claude, ollama, healthData] = await Promise.all([
        apiFetch<{ keys: ApiKeyEntry[] }>(workspaceId ? `/api/vault/keys?workspaceId=${encodeURIComponent(workspaceId)}` : '/api/vault/keys'),
        apiFetch<AgentConfig>('/api/config'),
        apiFetch<ClaudeAuthState>('/api/config/claude-auth'),
        apiFetch<OllamaStatus>('/api/config/ollama'),
        apiFetch<HealthResponse>('/api/health', { silent: true }).catch(() => null),
      ]);
      setKeys(keyData.keys);
      setAgentConfig(config);
      setClaudeAuth(claude);
      setOllamaStatus(ollama);
      setHealth(healthData);
      setOpenrouterViaEnv(!!(config as any).openrouterViaEnv);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Key helpers ────────────────────────────────────────────────────────────
  const findKey = (provider: string) => keys.find(k => k.provider === provider);

  const addKey = async (provider: string, key: string, label: string, baseUrl?: string) => {
    if (!workspaceId) { toast.show('No workspace selected', 'error'); return; }
    await apiFetch('/api/vault/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, provider, key, label, base_url: baseUrl }),
    });
    toast.show('API key added', 'success');
    fetchData();
  };

  const removeKey = async (id: string) => {
    if (!workspaceId) { toast.show('No workspace selected', 'error'); return; }
    await apiFetch(`/api/vault/keys/${id}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    toast.show('API key removed', 'success');
    fetchData();
  };

  const testConnection = async (provider: string) => {
    if (!workspaceId) { toast.show('No workspace selected', 'error'); return; }
    setTestingProvider(provider);
    try {
      const result = await apiFetch<{ ok: boolean; latencyMs: number; response: string }>('/api/vault/keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, provider }),
      });
      setTestResults(prev => ({ ...prev, [provider]: { ok: true, latencyMs: result.latencyMs } }));
    } catch (err: any) {
      setTestResults(prev => ({ ...prev, [provider]: { ok: false, error: err.message || 'Connection failed' } }));
    } finally {
      setTestingProvider(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted text-xs py-8 justify-center">
        <Loader2 size={14} className="animate-spin" /> Loading connections...
      </div>
    );
  }

  // ── Derive card data ───────────────────────────────────────────────────────
  const anthropicKey = findKey('anthropic');
  const openRouterKey = findKey('openrouter');
  const openAiKey = findKey('openai-compat');

  return (
    <div className="space-y-3 mt-4">
      <div className="flex items-center gap-2 mb-1">
        <Globe size={15} className="text-accent flex-shrink-0" />
        <span className="text-sm font-semibold text-[var(--text)]">Connections Hub</span>
        <span className="text-[10px] text-muted ml-1">Keys are AES-256-GCM encrypted at rest</span>
      </div>

      {/* 1. Claude CLI */}
      <ConnectionCard
        icon={<Terminal size={16} />}
        name="Claude CLI"
        description="Uses your Claude subscription via the claude CLI. No API key needed."
        statusDot={claudeAuth?.cliInstalled ? 'green' : 'grey'}
        statusLabel={
          claudeAuth?.cliInstalled
            ? `Installed${claudeAuth.cliVersion ? ` (v${claudeAuth.cliVersion})` : ''}${claudeAuth.connected ? ` — ${claudeAuth.email || 'authenticated'}` : ''}`
            : 'Not found'
        }
      >
        {claudeAuth?.cliInstalled && !claudeAuth.connected && (
          <p className="mt-2 ml-7 text-[11px] text-amber-400">CLI installed but not authenticated. Run: claude auth login</p>
        )}
      </ConnectionCard>

      {/* 2. OpenCode CLI */}
      <ConnectionCard
        icon={<Terminal size={16} />}
        name="OpenCode CLI"
        description="Uses the OpenCode CLI for API-key-backed execution across 75+ model providers."
        statusDot={agentConfig?.opencodeInstalled ? 'green' : 'amber'}
        statusLabel={
          agentConfig?.opencodeInstalled
            ? `Installed${agentConfig.opencodeVersion ? ` (v${agentConfig.opencodeVersion})` : ''}`
            : 'Not installed'
        }
      >
        {!agentConfig?.opencodeInstalled && (
          <p className="mt-2 ml-7 text-[11px] text-amber-400">Install with: npm install -g opencode</p>
        )}
      </ConnectionCard>

      {/* 3. Codex CLI */}
      <ConnectionCard
        icon={<Terminal size={16} />}
        name="Codex CLI"
        description="Uses your ChatGPT Plus/Pro subscription via the Codex CLI. No API key needed."
        statusDot={agentConfig?.codexInstalled ? 'green' : 'amber'}
        statusLabel={
          agentConfig?.codexInstalled
            ? `Installed${agentConfig.codexVersion ? ` (v${agentConfig.codexVersion})` : ''} — authenticated`
            : 'Not installed'
        }
      >
        {!agentConfig?.codexInstalled && (
          <p className="mt-2 ml-7 text-[11px] text-amber-400">Install with: npm install -g @openai/codex</p>
        )}
      </ConnectionCard>

      {/* 4. Pi CLI */}
      <PiEngineCard
        agentType={agentConfig?.agentType ?? null}
        piInstalled={health?.piInstalled ?? agentConfig?.piInstalled ?? false}
        piVersion={health?.piVersion ?? agentConfig?.piVersion ?? null}
        onRefreshAgentConfig={fetchData}
      />

      {/* 5. Anthropic API */}
      <ConnectionCard
        icon={<Cpu size={16} />}
        name="Anthropic API"
        description="Direct API access to Claude models. Requires an Anthropic API key."
        statusDot={anthropicKey ? 'green' : 'grey'}
        statusLabel={anthropicKey ? 'Configured' : 'Not configured'}
        maskedKey={anthropicKey?.masked_key}
        keyId={anthropicKey?.id}
        showAddKey
        addKeyPlaceholder="sk-ant-..."
        onAddKey={(key, label) => addKey('anthropic', key, label)}
        onRemoveKey={removeKey}
        onTestConnection={() => testConnection('anthropic')}
        testingConnection={testingProvider === 'anthropic'}
        testResult={testResults['anthropic'] ?? null}
      />

      {/* 6. OpenRouter */}
      <ConnectionCard
        icon={<Globe size={16} />}
        name="OpenRouter"
        description="Access 200+ models through a single API key."
        statusDot={openRouterKey || openrouterViaEnv ? 'green' : 'grey'}
        statusLabel={openRouterKey ? 'Configured' : openrouterViaEnv ? 'Active — via env var' : 'Not configured'}
        maskedKey={openRouterKey?.masked_key}
        keyId={openRouterKey?.id}
        showAddKey
        addKeyPlaceholder="sk-or-..."
        onAddKey={(key, label) => addKey('openrouter', key, label)}
        onRemoveKey={removeKey}
        onTestConnection={() => testConnection('openrouter')}
        testingConnection={testingProvider === 'openrouter'}
        testResult={testResults['openrouter'] ?? null}
      />

      {/* 7. OpenAI-Compatible */}
      <ConnectionCard
        icon={<Zap size={16} />}
        name="OpenAI-Compatible"
        description="Any OpenAI-compatible endpoint (OpenAI, Groq, Together, DeepSeek, etc.)."
        statusDot={openAiKey ? 'green' : 'grey'}
        statusLabel={openAiKey ? `Configured${openAiKey.base_url ? ` — ${openAiKey.base_url}` : ''}` : 'Not configured'}
        maskedKey={openAiKey?.masked_key}
        keyId={openAiKey?.id}
        showAddKey
        showBaseUrl
        addKeyPlaceholder="sk-..."
        baseUrlPlaceholder="https://api.openai.com/v1"
        baseUrlValue={openAiKey?.base_url || ''}
        onAddKey={(key, label, baseUrl) => addKey('openai-compat', key, label, baseUrl)}
        onRemoveKey={removeKey}
        onTestConnection={() => testConnection('openai-compat')}
        testingConnection={testingProvider === 'openai-compat'}
        testResult={testResults['openai-compat'] ?? null}
      />

      {/* 8. Ollama */}
      <ConnectionCard
        icon={<Cpu size={16} />}
        name="Ollama"
        description="Local model execution. No API key needed — configure host and port."
        statusDot={ollamaStatus?.available ? 'green' : 'grey'}
        statusLabel={
          ollamaStatus?.available
            ? `Running (${ollamaStatus.models.length} model${ollamaStatus.models.length !== 1 ? 's' : ''})`
            : ollamaStatus?.error || 'Not running'
        }
      >
        {ollamaStatus?.available && ollamaStatus.models.length > 0 && (
          <div className="mt-2 ml-7">
            <p className="text-[10px] text-muted mb-1">Available models:</p>
            <div className="flex flex-wrap gap-1">
              {ollamaStatus.models.slice(0, 8).map(m => (
                <span key={m.id} className="px-1.5 py-0.5 text-[10px] bg-bg border border-border rounded font-mono text-muted">
                  {m.name}
                </span>
              ))}
              {ollamaStatus.models.length > 8 && (
                <span className="px-1.5 py-0.5 text-[10px] text-muted">+{ollamaStatus.models.length - 8} more</span>
              )}
            </div>
          </div>
        )}
        {!ollamaStatus?.available && (
          <p className="mt-2 ml-7 text-[11px] text-muted">
            Install Ollama from ollama.com, then run: ollama serve
          </p>
        )}
      </ConnectionCard>
    </div>
  );
}

type PiInstallMethod = keyof typeof PI_INSTALL_COMMANDS;

function formatPiTokenCount(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}K`;
  return String(tokens);
}

function PiInstallTabs() {
  const toast = useGlobalToast();
  const [activeTab, setActiveTab] = useState<PiInstallMethod>('npm');
  const tabEntries = Object.entries(PI_INSTALL_COMMANDS) as Array<[PiInstallMethod, string]>;
  const activeCommand = PI_INSTALL_COMMANDS[activeTab];

  const handleCopy = useCallback(async (method: PiInstallMethod) => {
    const command = PI_INSTALL_COMMANDS[method];
    if (!navigator.clipboard?.writeText) {
      toast.error('Clipboard access is unavailable here. Copy the command manually.');
      return;
    }

    try {
      await navigator.clipboard.writeText(command);
      toast.success(`${method.toUpperCase()} install command copied`);
    } catch {
      toast.error('Could not copy automatically. Copy the command manually.');
    }
  }, [toast]);

  return (
    <div className="mt-3 rounded-lg border border-border bg-bg">
      <div role="tablist" aria-label="Pi install methods" className="flex flex-wrap gap-1 border-b border-border p-1">
        {tabEntries.map(([method]) => {
          const isActive = method === activeTab;
          return (
            <button
              key={method}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`pi-install-panel-${method}`}
              id={`pi-install-tab-${method}`}
              onClick={() => setActiveTab(method)}
              className={`rounded-md px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide transition-colors ${
                isActive
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:bg-surface-100 hover:text-[var(--text)]'
              }`}
            >
              {method.toUpperCase()}
            </button>
          );
        })}
      </div>

      <div
        id={`pi-install-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`pi-install-tab-${activeTab}`}
        className="space-y-2 p-3"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <code className="block min-w-0 overflow-x-auto rounded-md border border-border bg-panel px-3 py-2 text-[11px] text-[var(--text)]">
            {activeCommand}
          </code>
          <button
            type="button"
            onClick={() => handleCopy(activeTab)}
            aria-label={`Copy ${activeTab.toUpperCase()} install command`}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-[11px] text-muted transition-colors hover:border-accent/40 hover:text-[var(--text)]"
          >
            <Copy size={11} />
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

function PiModelsSlideOver({
  isOpen,
  onClose,
  loading,
  error,
  models,
}: {
  isOpen: boolean;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  models: PiModel[];
}) {
  return (
    <SlideOver isOpen={isOpen} onClose={onClose} title="Pi Model Browser">
      <div className="p-4 sm:p-6">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-[var(--text)]">Available Pi Models</h3>
          <p className="mt-1 text-xs text-muted">
            Provider-authenticated models discovered from the local Pi CLI.
          </p>
        </div>

        {loading ? (
          <div className="flex min-h-40 items-center justify-center gap-2 rounded-xl border border-border bg-panel text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading models...
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
            {error}
          </div>
        ) : models.length === 0 ? (
          <div className="rounded-xl border border-border bg-panel p-4 text-sm text-muted">
            No Pi models were returned by the local CLI.
          </div>
        ) : (
          <>
            <div className="space-y-3 sm:hidden">
              {models.map((model) => (
                <div key={`${model.provider}:${model.model}`} className="rounded-xl border border-border bg-panel p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-[var(--text)]">{model.model}</div>
                      <div className="mt-1 text-xs text-muted">{model.provider}</div>
                    </div>
                    <div className="flex gap-1">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${model.thinking ? 'bg-emerald-500/10 text-emerald-400' : 'bg-surface-100 text-muted'}`}>Thinking</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${model.images ? 'bg-cyan-500/10 text-cyan-400' : 'bg-surface-100 text-muted'}`}>Images</span>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <dt className="text-muted">Context</dt>
                      <dd className="mt-1 text-[var(--text)]">{formatPiTokenCount(model.contextTokens)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Max Out</dt>
                      <dd className="mt-1 text-[var(--text)]">{formatPiTokenCount(model.maxOutTokens)}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>

            <div className="hidden overflow-x-auto sm:block">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                    <th className="px-3 py-2 font-medium">Provider</th>
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Context</th>
                    <th className="px-3 py-2 font-medium">Max Out</th>
                    <th className="px-3 py-2 font-medium">Thinking</th>
                    <th className="px-3 py-2 font-medium">Images</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => (
                    <tr key={`${model.provider}:${model.model}`} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-3 text-muted">{model.provider}</td>
                      <td className="px-3 py-3 font-medium text-[var(--text)]">{model.model}</td>
                      <td className="px-3 py-3 text-muted">{formatPiTokenCount(model.contextTokens)}</td>
                      <td className="px-3 py-3 text-muted">{formatPiTokenCount(model.maxOutTokens)}</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${model.thinking ? 'bg-emerald-500/10 text-emerald-400' : 'bg-surface-100 text-muted'}`}>
                          {model.thinking ? 'Yes' : 'No'}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${model.images ? 'bg-cyan-500/10 text-cyan-400' : 'bg-surface-100 text-muted'}`}>
                          {model.images ? 'Yes' : 'No'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </SlideOver>
  );
}

function PiEngineCard({
  agentType,
  piInstalled,
  piVersion,
  onRefreshAgentConfig,
}: {
  agentType: AgentConfig['agentType'] | null;
  piInstalled: boolean;
  piVersion: string | null;
  onRefreshAgentConfig: () => Promise<void>;
}) {
  const toast = useGlobalToast();
  const [models, setModels] = useState<PiModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [isSlideOverOpen, setIsSlideOverOpen] = useState(false);
  const [activating, setActivating] = useState(false);

  const providerCount = useMemo(
    () => new Set(models.map((model) => model.provider)).size,
    [models],
  );

  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const response = await apiFetch<PiModelsResponse>('/api/config/pi-models');
      setModels(Array.isArray(response.models) ? response.models : []);
      setModelsLoaded(true);
    } catch {
      setModels([]);
      setModelsLoaded(true);
      setModelsError('Could not load Pi models right now.');
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (piInstalled && !modelsLoaded && !modelsLoading) {
      fetchModels();
    }
  }, [piInstalled, modelsLoaded, modelsLoading, fetchModels]);

  const handleBrowseModels = useCallback(async () => {
    setIsSlideOverOpen(true);
    if (!piInstalled) return;
    if ((!modelsLoaded || modelsError) && !modelsLoading) {
      await fetchModels();
    }
  }, [fetchModels, modelsError, modelsLoaded, modelsLoading, piInstalled]);

  const handleSetActive = useCallback(async () => {
    setActivating(true);
    try {
      await apiFetch('/api/config/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'pi' }),
      });
      await onRefreshAgentConfig();
      toast.success('Pi is now the active execution engine');
    } catch {
      toast.error('Could not set Pi as the active engine');
    } finally {
      setActivating(false);
    }
  }, [onRefreshAgentConfig, toast]);

  const isActive = agentType === 'pi';
  const providerCountLabel = piInstalled
    ? modelsLoading && !modelsLoaded
      ? 'Loading provider catalog...'
      : `${providerCount} provider${providerCount === 1 ? '' : 's'} available`
    : '0 providers available';

  return (
    <>
      <div className="rounded-xl border border-border bg-panel p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-4 w-4 items-center justify-center text-sm font-semibold leading-none text-muted shrink-0">π</div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-[var(--text)]">Pi</span>
              <span className={`h-2 w-2 rounded-full shrink-0 ${piInstalled ? 'bg-green-500' : 'bg-amber-500'}`} />
              <span className="text-xs text-muted">
                {piInstalled ? `Detected${piVersion ? ` (v${piVersion})` : ''}` : 'Not installed'}
              </span>
              {isActive && (
                <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
                  Active
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-muted">
              Uses the Pi CLI as the 4th execution engine. Pi manages provider authentication natively.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:flex-row">
            <button
              type="button"
              onClick={handleBrowseModels}
              disabled={!piInstalled}
              className="flex items-center justify-center gap-1 px-2 py-1 text-[11px] border border-border rounded hover:border-accent/40 text-muted hover:text-[var(--text)] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <BookOpen size={10} />
              Browse Models
            </button>
            <button
              type="button"
              onClick={handleSetActive}
              disabled={!piInstalled || isActive || activating}
              className="flex items-center justify-center gap-1 px-2 py-1 text-[11px] rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50 bg-accent text-white hover:bg-accent/90"
            >
              {activating ? <Loader2 size={10} className="animate-spin" /> : isActive ? <Check size={10} /> : null}
              {isActive ? 'Active' : 'Set as Active'}
            </button>
          </div>
        </div>

        {!piInstalled && (
          <div className="ml-7 mt-3">
            <p className="text-[11px] text-amber-400">
              Install Pi with your preferred package manager.
            </p>
            <PiInstallTabs />
          </div>
        )}

        <div className="ml-7 mt-3 rounded-lg border border-border bg-bg p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-medium text-[var(--text)]">BYOA — Bring Your Own Auth</div>
              <p className="mt-1 text-[11px] text-muted">
                Pi manages provider authentication natively. Run <code className="rounded bg-panel px-1 py-0.5 font-mono text-[10px]">pi auth login &lt;provider&gt;</code> in your terminal. Rorca never stores Pi API keys.
              </p>
            </div>
            <span className="rounded-full border border-border px-2 py-1 text-[10px] font-medium text-muted whitespace-nowrap">
              {providerCountLabel}
            </span>
          </div>
        </div>
      </div>

      <PiModelsSlideOver
        isOpen={isSlideOverOpen}
        onClose={() => setIsSlideOverOpen(false)}
        loading={modelsLoading}
        error={modelsError}
        models={models}
      />
    </>
  );
}

// ─── Providers Section ──────────────────────────────────────────────────────

function ProvidersSection() {
  const toast = useGlobalToast();
  const { workspaceId } = useWorkspace();
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [defaultProvider, setDefaultProvider] = useState('claude-cli');
  const [savingDefault, setSavingDefault] = useState(false);
  const [savedDefault, setSavedDefault] = useState(false);

  // Add key form per provider
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [addKey, setAddKey] = useState('');
  const [addBaseUrl, setAddBaseUrl] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Test connection state
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ provider: string; ok: boolean; latencyMs?: number; response?: string; error?: string } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [provData, keyData, defaultData] = await Promise.all([
        apiFetch<{ providers: ProviderStatus[] }>(workspaceId
          ? `/api/vault/keys/providers?workspaceId=${encodeURIComponent(workspaceId)}`
          : '/api/vault/keys/providers'),
        apiFetch<{ keys: ApiKeyEntry[] }>(workspaceId
          ? `/api/vault/keys?workspaceId=${encodeURIComponent(workspaceId)}`
          : '/api/vault/keys'),
        workspaceId
          ? apiFetch<{ provider: string }>(`/api/vault/keys/default-provider?workspaceId=${encodeURIComponent(workspaceId)}`)
          : Promise.resolve({ provider: 'claude-cli' }),
      ]);
      setProviders(provData.providers);
      setKeys(keyData.keys);
      setDefaultProvider(defaultData.provider);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleAddKey = async (providerId: string) => {
    if (!workspaceId) {
      toast.show('Select a workspace first', 'error');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await apiFetch('/api/vault/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          provider: providerId,
          key: addKey,
          label: addLabel,
          base_url: providerId === 'openai-compat' && addBaseUrl ? addBaseUrl : undefined,
        }),
      });
      setAddKey('');
      setAddBaseUrl('');
      setAddLabel('');
      setAddingFor(null);
      toast.show('API key added', 'success');
      fetchData();
    } catch (err: any) {
      const msg = err.message || 'Failed to add key';
      setAddError(msg);
      toast.show(msg, 'error');
    } finally {
      setAdding(false);
    }
  };

  const removeKey = async (id: string) => {
    if (!workspaceId) {
      toast.show('Select a workspace first', 'error');
      return;
    }
    try {
      await apiFetch(`/api/vault/keys/${id}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
      toast.show('API key removed', 'success');
      fetchData();
    } catch {
      toast.show('Failed to remove API key', 'error');
    }
  };

  const testConnection = async (providerId: string) => {
    if (!workspaceId) {
      setTestResult({ provider: providerId, ok: false, error: 'Select a workspace first' });
      return;
    }
    setTestingProvider(providerId);
    setTestResult(null);
    try {
      const result = await apiFetch<{ ok: boolean; latencyMs: number; response: string }>('/api/vault/keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, provider: providerId }),
      });
      setTestResult({ provider: providerId, ok: true, latencyMs: result.latencyMs, response: result.response });
    } catch (err: any) {
      setTestResult({ provider: providerId, ok: false, error: err.message || 'Connection failed' });
    } finally {
      setTestingProvider(null);
    }
  };

  const saveDefaultProvider = async (provider: string) => {
    if (!workspaceId) return;
    setSavingDefault(true);
    setSavedDefault(false);
    try {
      await apiFetch('/api/vault/keys/default-provider', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, provider }),
      });
      setDefaultProvider(provider);
      setSavedDefault(true);
      setTimeout(() => setSavedDefault(false), 2000);
    } catch {
      // silent
    } finally {
      setSavingDefault(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading provider configuration...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)]">Provider Configuration</h2>
        <p className="text-xs text-muted mt-0.5">
          Configure LLM providers for spec generation. Keys are AES-256-GCM encrypted at rest.
        </p>
      </div>

      {/* Default provider selector */}
      {workspaceId && (
        <div className="border border-border rounded p-4 bg-bg">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-[var(--text)]">Default Provider</h3>
              <p className="text-xs text-muted mt-0.5">Used when no per-spec model override is set</p>
            </div>
            {savedDefault && (
              <span className="flex items-center gap-1 text-xs text-green-500">
                <Check size={12} /> Saved
              </span>
            )}
          </div>
          <select
            value={defaultProvider}
            onChange={e => saveDefaultProvider(e.target.value)}
            disabled={savingDefault}
            className="mt-3 w-full px-3 py-2 text-sm bg-panel border border-border rounded focus:border-accent outline-none"
          >
            {providers.map(p => (
              <option key={p.id} value={p.id} disabled={p.id !== 'claude-cli' && !p.configured}>
                {p.name}{!p.configured && p.id !== 'claude-cli' ? ' (not configured)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Provider cards */}
      <div className="space-y-3">
        {providers.map(p => {
          const providerKeys = keys.filter(k => k.provider === p.id);
          const isDefault = defaultProvider === p.id;

          return (
            <div key={p.id} className={`border rounded p-4 transition-colors ${isDefault ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg'
              }`}>
              {/* Provider header */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${p.configured ? 'bg-green-500' : 'bg-zinc-500'}`} />
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-[var(--text)]">{p.name}</span>
                      {isDefault && (
                        <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-accent/15 text-accent">
                          Default
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted mt-0.5">{PROVIDER_DESCRIPTIONS[p.id]}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {p.configured && (
                    <button
                      onClick={() => testConnection(p.id)}
                      disabled={testingProvider === p.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded hover:border-accent/40 text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50"
                    >
                      {testingProvider === p.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Globe size={12} />
                      )}
                      Test
                    </button>
                  )}
                  {p.id !== 'claude-cli' && (
                    <button
                      onClick={() => {
                        setAddingFor(addingFor === p.id ? null : p.id);
                        setAddKey('');
                        setAddBaseUrl('');
                        setAddLabel('');
                        setAddError(null);
                      }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 transition-colors"
                    >
                      <Plus size={12} /> {providerKeys.length > 0 ? 'Replace' : 'Add'} Key
                    </button>
                  )}
                </div>
              </div>

              {/* Test result */}
              {testResult && testResult.provider === p.id && (
                <div className={`mt-3 px-3 py-2 rounded text-xs flex items-center gap-2 ${testResult.ok
                    ? 'bg-green-500/10 border border-green-500/20 text-green-400'
                    : 'bg-red-500/10 border border-red-500/20 text-red-400'
                  }`}>
                  {testResult.ok ? (
                    <>
                      <CheckCircle2 size={14} />
                      Connected ({testResult.latencyMs}ms)
                      {testResult.response && <span className="text-muted ml-1 truncate">— {testResult.response}</span>}
                    </>
                  ) : (
                    <>
                      <XCircle size={14} />
                      {testResult.error}
                    </>
                  )}
                </div>
              )}

              {/* Existing keys */}
              {providerKeys.length > 0 && (
                <div className="mt-3 space-y-2">
                  {providerKeys.map(k => (
                    <div key={k.id} className="flex items-center justify-between px-3 py-2 rounded border border-border bg-panel">
                      <div className="min-w-0 flex items-center gap-3">
                        <Key size={12} className="text-muted shrink-0" />
                        <span className="font-mono text-xs text-muted">{k.masked_key}</span>
                        {k.label && <span className="text-xs text-[var(--text)] truncate">{k.label}</span>}
                        {k.base_url && (
                          <span className="text-xs text-muted truncate" title={k.base_url}>
                            {k.base_url}
                          </span>
                        )}
                        {k.spend_total_usd > 0 && <span className="text-xs text-muted">${k.spend_total_usd.toFixed(2)}</span>}
                      </div>
                      <button
                        onClick={() => removeKey(k.id)}
                        className="p-1 text-muted hover:text-red-500 transition-colors shrink-0"
                        title="Remove key"
                        aria-label="Remove API key"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add key form */}
              {addingFor === p.id && (
                <div className="mt-3 border border-border rounded p-3 space-y-3 bg-panel">
                  <div>
                    <label className="block text-xs text-muted mb-1">API Key</label>
                    <input
                      type="password"
                      value={addKey}
                      onChange={e => setAddKey(e.target.value)}
                      placeholder="sk-..."
                      className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
                      autoFocus
                    />
                  </div>
                  {p.id === 'openai-compat' && (
                    <div>
                      <label className="block text-xs text-muted mb-1">Base URL</label>
                      <input
                        type="url"
                        value={addBaseUrl}
                        onChange={e => setAddBaseUrl(e.target.value)}
                        placeholder="https://api.openai.com/v1"
                        className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none font-mono"
                      />
                      <p className="text-[10px] text-muted mt-1">Custom endpoint for Groq, Together, DeepSeek, Ollama, etc.</p>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-muted mb-1">Label (optional)</label>
                    <input
                      type="text"
                      value={addLabel}
                      onChange={e => setAddLabel(e.target.value)}
                      placeholder="e.g. Personal, Work"
                      className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
                    />
                  </div>
                  {addError && <p className="text-xs text-red-500">{addError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleAddKey(p.id)}
                      disabled={adding || !addKey}
                      className="flex items-center gap-2 px-4 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
                    >
                      {adding ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                      Save Key
                    </button>
                    <button
                      onClick={() => { setAddingFor(null); setAddError(null); }}
                      className="px-4 py-1.5 text-xs text-muted hover:text-[var(--text)] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}

// ─── Exa Search Provider Section ─────────────────────────────────────────────

function ExaSearchSection() {
  const { user } = useAuth();
  const userPlan = user?.app_metadata?.plan as string | undefined;
  const isFreePlan = !userPlan || userPlan === 'free';

  return (
    <div className="border border-border rounded p-4 bg-bg">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Search size={18} className="text-muted" />
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-[var(--text)]">Exa Search</span>
              <ProBadge />
            </div>
            <p className="text-xs text-muted mt-0.5">
              Neural search for spec generation — finds semantically relevant code patterns and library docs.
            </p>
          </div>
        </div>
        {isFreePlan ? (
          <a
            href="#billing"
            className="shrink-0 flex items-center gap-1 px-3 py-1.5 text-xs bg-accent/10 text-accent border border-accent/30 rounded hover:bg-accent/20 transition-colors"
          >
            Upgrade to unlock
          </a>
        ) : (
          <span className="shrink-0 text-xs text-muted italic">Coming soon</span>
        )}
      </div>
    </div>
  );
}

// ─── Display Section ─────────────────────────────────────────────────────────

function formatContextWindow(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1)}M`;
  return `${(tokens / 1000).toFixed(0)}K`;
}

function ModelCard({ model, isSelected, isWorkspaceOverride, onSelect, onTest, testResult, isTesting }: {
  model: DisplayModelOption;
  isSelected: boolean;
  isWorkspaceOverride: boolean;
  onSelect: () => void;
  onTest: () => void;
  testResult: ModelTestResult | null;
  isTesting: boolean;
}) {
  const speed = SPEED_LABELS[model.speedTier] ?? SPEED_LABELS.medium;
  const cost = COST_LABELS[model.costTier] ?? COST_LABELS.medium;
  const isAvailable = model.available !== false;

  return (
    <div
      className={`border rounded p-3 transition-colors ${
        !isAvailable
          ? 'border-border bg-bg/50 opacity-60 cursor-not-allowed'
          : isSelected
            ? 'border-accent/60 bg-accent/5 cursor-pointer'
            : 'border-border bg-bg hover:border-accent/30 cursor-pointer'
      }`}
      onClick={() => { if (isAvailable) onSelect(); }}
      title={!isAvailable ? (model.availabilityNote ?? 'Configure this provider to use the model.') : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[var(--text)]">{model.label}</span>
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-panel border border-border text-muted">{model.provider}</span>
            {isSelected && !isWorkspaceOverride && (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-accent/15 text-accent">
                Default
              </span>
            )}
            {isSelected && isWorkspaceOverride && (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-purple-500/15 text-purple-400">
                Workspace
              </span>
            )}
            {!isAvailable && (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-500/10 text-amber-400">
                Configure provider
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted">
            <span title="Context window">{formatContextWindow(model.contextWindow)} ctx</span>
            <span className={speed.color}>{speed.label}</span>
            <span className={cost.color}>${model.costTier === 'free' ? 'Free' : `${model.costPer1kInput.toFixed(4)}/${model.costPer1kOutput.toFixed(4)}`}</span>
          </div>
        </div>
        <button
          onClick={e => { e.stopPropagation(); if (isAvailable) onTest(); }}
          disabled={isTesting || !isAvailable}
          className="flex items-center gap-1 px-2 py-1 text-[11px] border border-border rounded hover:border-accent/40 text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50 shrink-0"
          title="Send a test prompt to this model"
        >
          {isTesting ? <Loader2 size={10} className="animate-spin" /> : <Zap size={10} />}
          Test
        </button>
      </div>
      {testResult && testResult.modelId === model.id && (
        <div className={`mt-2 px-2 py-1.5 rounded text-[11px] flex items-center gap-1.5 ${testResult.ok
            ? 'bg-green-500/10 border border-green-500/20 text-green-400'
            : 'bg-red-500/10 border border-red-500/20 text-red-400'
          }`}>
          {testResult.ok ? (
            <>
              <CheckCircle2 size={12} />
              {testResult.latencyMs}ms
              {testResult.response && <span className="text-muted ml-1 truncate">— {testResult.response}</span>}
            </>
          ) : (
            <>
              <XCircle size={12} />
              <span className="truncate">{testResult.error}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Model Browser Container (PM-008 — standalone, owns its own state) ───────

function ModelBrowserContainer() {
  const { workspaceId } = useWorkspace();
  const [models, setModels] = useState<DisplayModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState('claude-sonnet-4-6');
  const [workspaceModel, setWorkspaceModel] = useState<string | null>(null);
  const [workspaceModelInitial, setWorkspaceModelInitial] = useState<string | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);
  const [searchText, setSearchText] = useState('');
  const [activeProvider, setActiveProvider] = useState<string>('All');
  const [activeCostTier, setActiveCostTier] = useState<string>('All');
  const [activeSpeedTier, setActiveSpeedTier] = useState<string>('All');

  useEffect(() => {
    const fetchPromises: Promise<any>[] = [
      apiFetch<DisplaySettings>('/api/settings/display'),
      apiFetch<{ models: DisplayModelOption[]; defaultModel: string }>(`/api/direction/models${workspaceId ? `?workspaceId=${workspaceId}` : ''}`),
    ];
    if (workspaceId) {
      fetchPromises.push(
        apiFetch<{ contentYaml: string; preferredModel: string | null }>(`/api/direction?layer=3&workspaceId=${workspaceId}`)
      );
    }
    Promise.all(fetchPromises).then(([displayData, modelData, l3Data]) => {
      setDefaultModel(displayData.defaultModel);
      setModels(modelData.models);
      if (l3Data) {
        setWorkspaceModel(l3Data.preferredModel);
        setWorkspaceModelInitial(l3Data.preferredModel);
      }
    }).catch(() => { });
  }, [workspaceId]);

  const saveWorkspaceModel = async (modelId: string | null) => {
    if (!workspaceId) return;
    setSavingWorkspace(true);
    try {
      const l3 = await apiFetch<{ contentYaml: string; preferredModel: string | null }>(`/api/direction?layer=3&workspaceId=${workspaceId}`);
      await apiFetch('/api/direction', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layer: 3,
          workspaceId,
          contentYaml: l3.contentYaml || '',
          preferredModel: modelId,
          skipValidation: true,
        }),
      });
      setWorkspaceModel(modelId);
      setWorkspaceModelInitial(modelId);
    } catch { /* silent */ }
    finally { setSavingWorkspace(false); }
  };

  const testModel = async (modelId: string) => {
    setTestingModel(modelId);
    setTestResult(null);
    try {
      const result = await apiFetch<{ ok: boolean; latencyMs: number; response: string }>(`/api/models/${encodeURIComponent(modelId)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });
      setTestResult({ modelId, ok: true, latencyMs: result.latencyMs, response: result.response });
    } catch (err: any) {
      setTestResult({ modelId, ok: false, error: err.message || 'Test failed' });
    } finally {
      setTestingModel(null);
    }
  };

  const effectiveModel = workspaceModel ?? defaultModel;

  // Suppress unused variable warning — savingWorkspace used indirectly via saveWorkspaceModel
  void savingWorkspace;
  void workspaceModelInitial;

  return (
    <ModelBrowserSection
      models={models}
      effectiveModel={effectiveModel}
      workspaceModel={workspaceModel}
      workspaceId={workspaceId ?? null}
      searchText={searchText}
      setSearchText={setSearchText}
      activeProvider={activeProvider}
      setActiveProvider={setActiveProvider}
      activeCostTier={activeCostTier}
      setActiveCostTier={setActiveCostTier}
      activeSpeedTier={activeSpeedTier}
      setActiveSpeedTier={setActiveSpeedTier}
      testResult={testResult}
      testingModel={testingModel}
      onSelectModel={(m) => {
        if (workspaceId) {
          setWorkspaceModel(m.id);
          saveWorkspaceModel(m.id);
        } else {
          setDefaultModel(m.id);
        }
      }}
      onTestModel={(id) => testModel(id)}
    />
  );
}

// ─── Model Browser Section (PM-005) ──────────────────────────────────────────

type SortOption = 'best' | 'cost-asc' | 'cost-desc' | 'context' | 'speed';

function ModelBrowserSection({
  models,
  effectiveModel,
  workspaceModel,
  workspaceId,
  searchText,
  setSearchText,
  activeProvider,
  setActiveProvider,
  activeCostTier,
  setActiveCostTier,
  activeSpeedTier,
  setActiveSpeedTier,
  testResult,
  testingModel,
  onSelectModel,
  onTestModel,
}: {
  models: DisplayModelOption[];
  effectiveModel: string;
  workspaceModel: string | null;
  workspaceId: string | null;
  searchText: string;
  setSearchText: (v: string) => void;
  activeProvider: string;
  setActiveProvider: (v: string) => void;
  activeCostTier: string;
  setActiveCostTier: (v: string) => void;
  activeSpeedTier: string;
  setActiveSpeedTier: (v: string) => void;
  testResult: ModelTestResult | null;
  testingModel: string | null;
  onSelectModel: (m: DisplayModelOption) => void;
  onTestModel: (id: string) => void;
}) {
  const [sortBy, setSortBy] = useState<SortOption>('best');

  const SPEED_ORDER: Record<string, number> = { fast: 0, medium: 1, slow: 2 };

  // Compute per-provider counts respecting active cost+speed filters (but not provider filter)
  // so that tab counts reflect what's visible in those tiers
  const providerTabCounts = useMemo(() => {
    const q = searchText.toLowerCase();
    const counts: Record<string, number> = {};
    for (const m of models) {
      if (
        (activeCostTier === 'All' || m.costTier === activeCostTier) &&
        (activeSpeedTier === 'All' || m.speedTier === activeSpeedTier) &&
        (!q || m.label.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      ) {
        counts[m.provider] = (counts[m.provider] ?? 0) + 1;
      }
    }
    return counts;
  }, [models, searchText, activeCostTier, activeSpeedTier]);

  const providers = useMemo(
    () => Object.entries(
      models.reduce<Record<string, number>>((acc, m) => {
        acc[m.provider] = (acc[m.provider] ?? 0) + 1;
        return acc;
      }, {})
    )
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => p),
    [models]
  );

  const filtered = useMemo(() => {
    const q = searchText.toLowerCase();
    const base = models.filter(m =>
      (activeProvider === 'All' || m.provider === activeProvider) &&
      (activeCostTier === 'All' || m.costTier === activeCostTier) &&
      (activeSpeedTier === 'All' || m.speedTier === activeSpeedTier) &&
      (!q || m.label.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    );
    switch (sortBy) {
      case 'cost-asc':
        return [...base].sort((a, b) => a.costPer1kInput - b.costPer1kInput);
      case 'cost-desc':
        return [...base].sort((a, b) => b.costPer1kInput - a.costPer1kInput);
      case 'context':
        return [...base].sort((a, b) => b.contextWindow - a.contextWindow);
      case 'speed':
        return [...base].sort((a, b) => (SPEED_ORDER[a.speedTier] ?? 1) - (SPEED_ORDER[b.speedTier] ?? 1));
      default:
        return base;
    }
  }, [models, searchText, activeProvider, activeCostTier, activeSpeedTier, sortBy]);

  const clearFilters = () => {
    setSearchText('');
    setActiveProvider('All');
    setActiveCostTier('All');
    setActiveSpeedTier('All');
    setSortBy('best');
  };

  const totalProviderCount = providerTabCounts['All'] ?? models.length;

  return (
    <div className="rounded-xl border border-border bg-panel p-5 mt-4">
      {/* Card header */}
      <div className="flex items-center gap-2 mb-4">
        <Search size={15} className="text-accent flex-shrink-0" />
        <span className="text-sm font-semibold text-[var(--text)]">Model Browser</span>
        <span className="bg-panel border border-border rounded-full px-2 py-0.5 text-xs text-muted ml-auto">
          {filtered.length} models
        </span>
      </div>

      {/* Search input */}
      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <input
          type="text"
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          placeholder={`Search ${models.length} models...`}
          className="w-full text-sm bg-bg border border-border rounded-lg px-3 py-2 pl-9 focus:border-accent/50 outline-none placeholder:text-muted"
        />
      </div>

      {/* Provider tab strip */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 mb-4 scrollbar-hide">
        {(['All', ...providers]).map(p => {
          const count = p === 'All' ? totalProviderCount : (providerTabCounts[p] ?? 0);
          return (
            <button
              key={p}
              onClick={() => setActiveProvider(p)}
              className={`px-3 py-1 text-xs rounded-full border whitespace-nowrap flex-shrink-0 transition-colors ${
                activeProvider === p
                  ? 'border-accent bg-accent/10 text-accent font-medium'
                  : 'border-border text-muted hover:text-[var(--text)]'
              }`}
            >
              {p} {count > 0 && <span className="ml-1 opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* COST + SPEED filter rows */}
      <div className="flex flex-col gap-2 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold text-muted uppercase tracking-widest w-10 flex-shrink-0">COST</span>
          {(['All', 'free', 'low', 'medium', 'high', 'premium'] as const).map(tier => (
            <button
              key={tier}
              onClick={() => setActiveCostTier(tier)}
              className={`px-2.5 py-0.5 text-xs rounded border transition-colors ${
                activeCostTier === tier
                  ? 'border-accent/60 bg-accent/10 text-accent'
                  : 'border-border text-muted hover:text-[var(--text)]'
              }`}
            >
              {tier === 'All' ? 'All' : COST_LABELS[tier].label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold text-muted uppercase tracking-widest w-10 flex-shrink-0">SPEED</span>
          {(['All', 'fast', 'medium', 'slow'] as const).map(tier => (
            <button
              key={tier}
              onClick={() => setActiveSpeedTier(tier)}
              className={`px-2.5 py-0.5 text-xs rounded border transition-colors ${
                activeSpeedTier === tier
                  ? 'border-accent/60 bg-accent/10 text-accent'
                  : 'border-border text-muted hover:text-[var(--text)]'
              }`}
            >
              {tier === 'All' ? 'All' : SPEED_LABELS[tier].label}
            </button>
          ))}
        </div>
      </div>

      {/* Result count + sort */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-muted">{filtered.length} models</span>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as SortOption)}
          className="text-xs bg-bg border border-border rounded px-2 py-1 text-muted focus:border-accent/50 outline-none"
        >
          <option value="best">Best Match</option>
          <option value="cost-asc">Cost ↑</option>
          <option value="cost-desc">Cost ↓</option>
          <option value="context">Context Window</option>
          <option value="speed">Speed</option>
        </select>
      </div>

      {/* Model grid or empty state */}
      {filtered.length === 0 ? (
        <div className="py-10 flex flex-col items-center gap-3 text-center">
          <Search size={24} className="text-muted opacity-40" />
          <p className="text-sm text-muted">No models match your filters</p>
          <button
            onClick={clearFilters}
            className="text-xs text-accent hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="grid gap-3 mt-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))' }}>
          {filtered.map(m => (
            <ModelCard
              key={m.id}
              model={m}
              isSelected={m.id === effectiveModel}
              isWorkspaceOverride={m.id === workspaceModel}
              onSelect={() => onSelectModel(m)}
              onTest={() => onTestModel(m.id)}
              testResult={testResult}
              isTesting={testingModel === m.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Workflow Router Types ─────────────────────────────────────────────────

interface WorkflowConfig {
  workflowId: string;
  runtime: string;
  provider: string;
  model: string | null;
  hasApiKey: boolean;
  updatedAt: string;
}

const WORKFLOW_LABELS: Record<string, { name: string; description: string }> = {
  spec_generation: { name: 'Spec Generation', description: 'LLM calls to generate specs from briefs' },
  pipeline_execution: { name: 'Pipeline Execution', description: 'Agent subprocess per story (claude / opencode / codex)' },
  memory_consolidation: { name: 'Memory Consolidation', description: 'Post-run memory synthesis and recall' },
};

const WORKFLOW_ORDER = ['spec_generation', 'pipeline_execution', 'memory_consolidation'];

// ─── Runtime Segment Options ──────────────────────────────────────────────

interface CliInstallStatus {
  opencodeInstalled: boolean;
  codexInstalled: boolean;
  piInstalled: boolean;
}

const RUNTIME_SEGMENTS: { value: string; label: string; installedKey: keyof CliInstallStatus | null }[] = [
  { value: 'claude', label: 'Claude', installedKey: null }, // always installed
  { value: 'opencode', label: 'OpenCode', installedKey: 'opencodeInstalled' },
  { value: 'codex', label: 'Codex', installedKey: 'codexInstalled' },
  { value: 'pi', label: 'Pi', installedKey: 'piInstalled' },
];

// ─── Workflow Router Section ──────────────────────────────────────────────

// Provider options that require API keys (vault keys)
const API_PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic API' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai-compat', label: 'OpenAI-Compatible' },
];

/** Maps workflow_configs.provider to ModelOption.providerType for filtering */
function providerToModelFilter(provider: string): (m: ModelOption) => boolean {
  if (provider === 'claude-cli') return m => m.providerType === 'anthropic';
  return m => m.providerType === provider;
}

/** Compact searchable model select for workflow router table cells */
function WorkflowModelSelect({ models, value, provider, onChange, disabled }: {
  models: ModelOption[];
  value: string | null;
  provider: string;
  onChange: (modelId: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const filtered = useMemo(() => {
    const providerModels = models.filter(providerToModelFilter(provider));
    const q = query.toLowerCase().trim();
    if (!q) return providerModels;
    return providerModels.filter(m =>
      m.label.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q)
    );
  }, [models, provider, query]);

  const selected = value ? models.find(m => m.id === value) : null;

  useEffect(() => { setHighlightIdx(0); }, [query]);

  // Position dropdown
  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const dropdownHeight = 280;
      const openUp = spaceBelow < dropdownHeight && rect.top > spaceBelow;
      setDropdownPos({
        top: openUp ? rect.top - dropdownHeight : rect.bottom + 4,
        left: rect.left,
        width: Math.max(rect.width, 260),
      });
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery('');
      setDropdownPos(null);
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(t) &&
        dropdownRef.current && !dropdownRef.current.contains(t)
      ) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  // Scroll highlighted into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-wm-item]');
    items[highlightIdx]?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx, open]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    // +1 for the Clear option at index 0
    const totalItems = filtered.length + 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIdx(i => Math.min(i + 1, totalItems - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIdx(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightIdx === 0) { onChange(null); setOpen(false); }
        else if (filtered[highlightIdx - 1]) { onChange(filtered[highlightIdx - 1].id); setOpen(false); }
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
    }
  }, [open, filtered, highlightIdx, onChange]);

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs bg-panel border border-border rounded outline-none hover:border-accent/50 focus:border-accent transition-colors text-left max-w-[220px] ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Select model"
      >
        {selected ? (
          <span className="truncate font-mono text-[var(--text)]">{selected.label}</span>
        ) : (
          <span className="text-muted italic">Provider Default</span>
        )}
        <ChevronDown size={10} className={`text-muted/60 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && dropdownPos && (
        <div
          ref={dropdownRef}
          className="fixed bg-[var(--panel)] border border-[var(--border)] rounded-lg z-[9999] overflow-hidden"
          style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width, boxShadow: '0 4px 24px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.12)' }}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
            <Search size={12} className="text-muted/50 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search models..."
              className="flex-1 bg-transparent text-xs text-text placeholder:text-muted/40 outline-none"
              aria-label="Search models"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-[10px] text-muted/50 hover:text-muted transition-colors">Clear</button>
            )}
          </div>

          {/* Model list */}
          <div ref={listRef} className="max-h-56 overflow-y-auto" role="listbox">
            {/* Clear / Provider Default option */}
            <button
              data-wm-item
              type="button"
              role="option"
              aria-selected={value === null}
              onClick={() => { onChange(null); setOpen(false); }}
              onMouseEnter={() => setHighlightIdx(0)}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                highlightIdx === 0
                  ? 'bg-accent/8 text-[var(--text)]'
                  : 'text-[var(--text)]/80 hover:bg-[var(--surface-100)]'
              }`}
            >
              <span className="w-3 shrink-0">
                {value === null && <Check size={10} className="text-accent" />}
              </span>
              <X size={10} className="text-muted/50 shrink-0" />
              <span className="italic text-muted">Provider Default</span>
            </button>

            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-[10px] text-muted">
                No models match "{query}"
              </div>
            ) : (
              filtered.map((m, i) => {
                const idx = i + 1; // offset by 1 for Clear option
                const isSelected = m.id === value;
                const isHighlighted = idx === highlightIdx;
                return (
                  <button
                    key={m.id}
                    data-wm-item
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => { onChange(m.id); setOpen(false); }}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                      isHighlighted
                        ? 'bg-accent/8 text-[var(--text)]'
                        : 'text-[var(--text)]/80 hover:bg-[var(--surface-100)]'
                    }`}
                  >
                    <span className="w-3 shrink-0">
                      {isSelected && <Check size={10} className="text-accent" />}
                    </span>
                    <span className={`truncate flex-1 ${isSelected ? 'font-medium' : ''}`}>{m.label}</span>
                    {m.costPer1kInput != null && (
                      <span className="text-[10px] font-mono text-muted/50 shrink-0">
                        {m.costPer1kInput === 0 ? 'Free' : `$${m.costPer1kInput < 0.001 ? m.costPer1kInput.toFixed(4) : m.costPer1kInput.toFixed(3)}/1K`}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function WorkflowRouterSection() {
  const toast = useGlobalToast();
  const [configs, setConfigs] = useState<WorkflowConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [cliStatus, setCliStatus] = useState<CliInstallStatus>({ opencodeInstalled: false, codexInstalled: false, piInstalled: false });
  const [vaultKeys, setVaultKeys] = useState<ApiKeyEntry[]>([]);
  const [allModels, setAllModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    Promise.all([
      apiFetch<WorkflowConfig[]>('/api/workflow-router'),
      apiFetch<CliInstallStatus>('/api/config'),
      apiFetch<{ keys: ApiKeyEntry[] }>('/api/vault/keys'),
      apiFetch<{ models: ModelOption[] }>('/api/direction/models'),
    ])
      .then(([cfgs, status, keyData, modelData]) => {
        setConfigs(Array.isArray(cfgs) ? cfgs : []);
        setCliStatus({
          opencodeInstalled: !!status?.opencodeInstalled,
          codexInstalled: !!status?.codexInstalled,
          piInstalled: !!status?.piInstalled,
        });
        setVaultKeys(Array.isArray(keyData?.keys) ? keyData.keys : []);
        setAllModels(Array.isArray(modelData?.models) ? modelData.models : []);
      })
      .catch(() => { /* silently fail — table shows empty */ })
      .finally(() => setLoading(false));
  }, []);

  // All provider options — claude-cli always available, API providers always shown (warning badge if no vault key)
  const configuredProviders = useMemo(() => {
    return [
      { value: 'claude-cli', label: 'Claude CLI' },
      ...API_PROVIDER_OPTIONS,
    ];
  }, []);

  // Set of providers with vault keys (for warning badge check)
  const vaultProviderSet = useMemo(() => new Set(vaultKeys.map(k => k.provider)), [vaultKeys]);

  // Sort by canonical order
  const sorted = useMemo(() => {
    const map = new Map(configs.map(c => [c.workflowId, c]));
    return WORKFLOW_ORDER.map(id => map.get(id)).filter(Boolean) as WorkflowConfig[];
  }, [configs]);

  const handleRuntimeChange = useCallback(async (newRuntime: string) => {
    const prev = configs.find(c => c.workflowId === 'pipeline_execution');
    if (!prev || prev.runtime === newRuntime) return;

    // Optimistic update
    setConfigs(cs => cs.map(c => c.workflowId === 'pipeline_execution' ? { ...c, runtime: newRuntime } : c));

    try {
      const updated = await apiFetch<{ workflowId: string; runtime: string; provider: string; model: string | null; updatedAt: string }>(
        '/api/workflow-router/pipeline_execution',
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime: newRuntime }) },
      );
      // Apply server response
      setConfigs(cs => cs.map(c => c.workflowId === 'pipeline_execution'
        ? { ...c, runtime: updated.runtime, provider: updated.provider, model: updated.model, updatedAt: updated.updatedAt }
        : c));
    } catch {
      // Revert on failure
      setConfigs(cs => cs.map(c => c.workflowId === 'pipeline_execution' ? prev : c));
      toast.show('Failed to update runtime', 'error');
    }
  }, [configs, toast]);

  const handleProviderChange = useCallback(async (workflowId: string, newProvider: string) => {
    const prev = configs.find(c => c.workflowId === workflowId);
    if (!prev || prev.provider === newProvider) return;

    // Check if current model is compatible with the new provider
    const newProviderModels = allModels.filter(providerToModelFilter(newProvider));
    const modelStillValid = prev.model && newProviderModels.some(m => m.id === prev.model);
    const resetModel = prev.model && !modelStillValid;

    // Optimistic update — also reset model if incompatible
    setConfigs(cs => cs.map(c => c.workflowId === workflowId
      ? { ...c, provider: newProvider, model: resetModel ? null : c.model }
      : c));

    try {
      const body: Record<string, string | null> = { provider: newProvider };
      if (resetModel) body.model = null;

      const updated = await apiFetch<{ workflowId: string; runtime: string; provider: string; model: string | null; updatedAt: string }>(
        `/api/workflow-router/${workflowId}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      setConfigs(cs => cs.map(c => c.workflowId === workflowId
        ? { ...c, provider: updated.provider, model: updated.model, updatedAt: updated.updatedAt }
        : c));
    } catch {
      setConfigs(cs => cs.map(c => c.workflowId === workflowId ? prev : c));
      toast.show('Failed to update provider', 'error');
    }
  }, [configs, allModels, toast]);

  const handleModelChange = useCallback(async (workflowId: string, newModel: string | null) => {
    const prev = configs.find(c => c.workflowId === workflowId);
    if (!prev || prev.model === newModel) return;

    // Optimistic update
    setConfigs(cs => cs.map(c => c.workflowId === workflowId ? { ...c, model: newModel } : c));

    try {
      const updated = await apiFetch<{ workflowId: string; runtime: string; provider: string; model: string | null; updatedAt: string }>(
        `/api/workflow-router/${workflowId}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: newModel }) },
      );
      setConfigs(cs => cs.map(c => c.workflowId === workflowId
        ? { ...c, model: updated.model, updatedAt: updated.updatedAt }
        : c));
    } catch {
      setConfigs(cs => cs.map(c => c.workflowId === workflowId ? prev : c));
      toast.show('Failed to update model', 'error');
    }
  }, [configs, toast]);

  return (
    <div className="rounded-xl border border-border bg-panel p-5">
      <div className="flex items-center gap-2 mb-4">
        <GitBranch size={15} className="text-accent flex-shrink-0" />
        <span className="text-sm font-semibold text-[var(--text)]">Workflow Router</span>
      </div>
      <p className="text-xs text-muted mb-4">
        Per-workflow runtime, provider, and model configuration. Each workflow can target a different engine.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="pb-2 pr-4 text-xs font-medium text-muted">Workflow</th>
              <th className="pb-2 pr-4 text-xs font-medium text-muted">Runtime</th>
              <th className="pb-2 pr-4 text-xs font-medium text-muted">Provider</th>
              <th className="pb-2 text-xs font-medium text-muted">Model</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <>
                {[0, 1, 2].map(i => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-3 pr-4"><div className="h-4 w-32 rounded bg-surface-100 animate-pulse" /></td>
                    <td className="py-3 pr-4"><div className="h-4 w-20 rounded bg-surface-100 animate-pulse" /></td>
                    <td className="py-3 pr-4"><div className="h-4 w-24 rounded bg-surface-100 animate-pulse" /></td>
                    <td className="py-3"><div className="h-4 w-36 rounded bg-surface-100 animate-pulse" /></td>
                  </tr>
                ))}
              </>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted text-xs">
                  No workflow configurations found
                </td>
              </tr>
            ) : (
              sorted.map(cfg => {
                const label = WORKFLOW_LABELS[cfg.workflowId];
                const isPipeline = cfg.workflowId === 'pipeline_execution';
                return (
                  <tr key={cfg.workflowId} className="border-b border-border/50 last:border-0">
                    <td className="py-3 pr-4">
                      <div className="text-[var(--text)] font-medium">{label?.name ?? cfg.workflowId}</div>
                      <div className="text-xs text-muted mt-0.5">{label?.description ?? ''}</div>
                    </td>
                    <td className="py-3 pr-4">
                      {isPipeline ? (
                        <div className="inline-flex rounded-lg border border-border overflow-hidden">
                          {RUNTIME_SEGMENTS.map(seg => {
                            const isActive = cfg.runtime === seg.value;
                            const isInstalled = seg.installedKey === null || cliStatus[seg.installedKey];
                            return (
                              <button
                                key={seg.value}
                                onClick={() => handleRuntimeChange(seg.value)}
                                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-colors ${
                                  isActive
                                    ? 'bg-accent/10 text-accent'
                                    : 'bg-panel text-muted hover:text-[var(--text)] hover:bg-surface-100'
                                }`}
                              >
                                <span
                                  className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                    isInstalled ? 'bg-emerald-500' : 'bg-amber-500'
                                  }`}
                                />
                                {seg.label}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-surface-100 text-muted">
                          <Lock size={10} className="flex-shrink-0" />
                          Native Engine
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      {(() => {
                        // Pipeline execution: locked when runtime is 'claude' or 'codex'
                        const isProviderLocked = isPipeline && (cfg.runtime === 'claude' || cfg.runtime === 'codex' || cfg.runtime === 'pi');
                        // Warning: selected provider is an API provider but has no vault key
                        const needsWarning = cfg.provider !== 'claude-cli' && !vaultProviderSet.has(cfg.provider);

                        if (isProviderLocked) {
                          return (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-surface-100 text-muted">
                              <Lock size={10} className="flex-shrink-0" />
                              claude-cli
                            </span>
                          );
                        }

                        return (
                          <div className="inline-flex items-center gap-1.5">
                            <select
                              value={cfg.provider}
                              onChange={e => handleProviderChange(cfg.workflowId, e.target.value)}
                              className="px-2 py-1 text-xs bg-panel border border-border rounded focus:border-accent outline-none text-[var(--text)] cursor-pointer appearance-none pr-6"
                              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center' }}
                            >
                              {configuredProviders.map(p => (
                                <option key={p.value} value={p.value}>{p.label}</option>
                              ))}
                              {/* Show current value even if its key was removed */}
                              {cfg.provider !== 'claude-cli' && !configuredProviders.some(p => p.value === cfg.provider) && (
                                <option value={cfg.provider}>
                                  {API_PROVIDER_OPTIONS.find(p => p.value === cfg.provider)?.label ?? cfg.provider}
                                </option>
                              )}
                            </select>
                            {needsWarning && (
                              <span title="API key not configured for this provider" className="text-amber-400 flex-shrink-0">
                                <AlertTriangle size={12} />
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="py-3">
                      <WorkflowModelSelect
                        models={allModels}
                        value={cfg.model}
                        provider={cfg.provider}
                        onChange={modelId => handleModelChange(cfg.workflowId, modelId)}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DisplaySection() {
  const toast = useGlobalToast();
  const { mode, setMode } = useTheme();
  const { workspaceId } = useWorkspace();
  const [settings, setSettings] = useState<DisplaySettings | null>(null);
  const [models, setModels] = useState<DisplayModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [defaultModel, setDefaultModel] = useState('claude-sonnet-4-6');
  const [itemsPerPage, setItemsPerPage] = useState(20);

  // Per-workspace preferred model override
  const [workspaceModel, setWorkspaceModel] = useState<string | null>(null);
  const [workspaceModelInitial, setWorkspaceModelInitial] = useState<string | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [savedWorkspace, setSavedWorkspace] = useState(false);

  useEffect(() => {
    const fetchPromises: Promise<any>[] = [
      apiFetch<DisplaySettings>('/api/settings/display'),
      apiFetch<{ models: DisplayModelOption[]; defaultModel: string }>(`/api/direction/models${workspaceId ? `?workspaceId=${workspaceId}` : ''}`),
    ];
    if (workspaceId) {
      fetchPromises.push(
        apiFetch<{ contentYaml: string; preferredModel: string | null }>(`/api/direction?layer=3&workspaceId=${workspaceId}`)
      );
    }

    Promise.all(fetchPromises).then(([displayData, modelData, l3Data]) => {
      setSettings(displayData);
      setDefaultModel(displayData.defaultModel);
      setItemsPerPage(displayData.itemsPerPage);
      setModels(modelData.models);
      if (l3Data) {
        setWorkspaceModel(l3Data.preferredModel);
        setWorkspaceModelInitial(l3Data.preferredModel);
      }
    }).catch(() => { })
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const saveDisplay = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await apiFetch('/api/settings/display', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultModel, itemsPerPage }),
      });
      setSettings(prev => prev ? { ...prev, defaultModel, itemsPerPage } : prev);
      setSaved(true);
      toast.show('Display settings saved', 'success');
      setTimeout(() => setSaved(false), 2000);
    } catch {
      toast.show('Failed to save display settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveWorkspaceModel = async (modelId: string | null) => {
    if (!workspaceId) return;
    setSavingWorkspace(true);
    setSavedWorkspace(false);
    try {
      const l3 = await apiFetch<{ contentYaml: string; preferredModel: string | null }>(`/api/direction?layer=3&workspaceId=${workspaceId}`);
      await apiFetch('/api/direction', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layer: 3,
          workspaceId,
          contentYaml: l3.contentYaml || '',
          preferredModel: modelId,
          skipValidation: true,
        }),
      });
      setWorkspaceModel(modelId);
      setWorkspaceModelInitial(modelId);
      setSavedWorkspace(true);
      setTimeout(() => setSavedWorkspace(false), 2000);
    } catch {
      // silent
    } finally {
      setSavingWorkspace(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading display settings...</div>;
  }

  const hasChanges = settings !== null && defaultModel !== settings.defaultModel;

  return (
      <div className="rounded-xl border border-border bg-panel p-5">
        {/* Card header */}
        <div className="flex items-center gap-2 mb-4">
          <SlidersHorizontal size={15} className="text-accent" />
          <span className="text-sm font-semibold text-[var(--text)]">Display</span>
        </div>

        {/* Two-column grid: Theme | Default Model */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {/* Theme */}
          <div>
            <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Theme</p>
            <div className="flex rounded-lg border border-border overflow-hidden">
              {(['light', 'dark', 'system'] as ThemeMode[]).map((m, i) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 px-3 py-1.5 text-xs capitalize transition-colors ${i > 0 ? 'border-l border-border' : ''} ${mode === m
                      ? 'bg-accent text-white'
                      : 'bg-bg text-muted hover:text-[var(--text)]'
                    }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Default Model */}
          <div>
            <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Default Model</p>
            <div className="flex gap-2 items-center">
              <div className="flex-1 min-w-0">
                <ModelSearchSelect
                  models={models}
                  value={defaultModel}
                  defaultModelId={null}
                  onChange={setDefaultModel}
                />
              </div>
              {hasChanges && (
                <button
                  onClick={saveDisplay}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors shrink-0"
                >
                  {saving ? <Loader2 size={12} className="animate-spin inline" /> : saved ? <Check size={12} className="inline" /> : 'Save'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Workspace Model Override — full-width row below grid */}
        {workspaceId && (
          <div className="mt-6 pt-5 border-t border-border">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-muted uppercase tracking-wider">Workspace Model Override</p>
              {savedWorkspace && (
                <span className="flex items-center gap-1 text-xs text-green-500"><Check size={12} /> Saved</span>
              )}
            </div>
            <div className="flex gap-2 items-center">
              <div className="flex-1 min-w-0">
                <ModelSearchSelect
                  models={[
                    { id: '', label: `Use global default (${models.find(m => m.id === defaultModel)?.label ?? defaultModel})`, provider: '', costPer1kInput: 0, costPer1kOutput: 0, recommended: false },
                    ...models,
                  ]}
                  value={workspaceModel ?? ''}
                  defaultModelId={null}
                  onChange={modelId => setWorkspaceModel(modelId || null)}
                  disabled={savingWorkspace}
                />
              </div>
              <button
                onClick={() => saveWorkspaceModel(workspaceModel)}
                disabled={savingWorkspace || workspaceModel === workspaceModelInitial}
                className="px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors shrink-0"
              >
                {savingWorkspace ? <Loader2 size={12} className="animate-spin inline" /> : 'Save'}
              </button>
            </div>
          </div>
        )}

        {/* itemsPerPage deprecated */}
      </div>
  );
}

// ─── Reasoning Defaults Section (RE-010) ─────────────────────────────────────

const EFFORT_OPTIONS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

const OVERRIDE_OPTIONS: { value: ReasoningModelDefault['override']; label: string; description: string }[] = [
  { value: 'auto', label: 'Auto', description: 'Use global setting' },
  { value: 'force-on', label: 'Force On', description: 'Always enable for this model' },
  { value: 'force-off', label: 'Force Off', description: 'Always disable for this model' },
];

interface ReasoningModelRowProps {
  modelId: string;
  modelLabel: string;
  supportsReasoning: boolean;
  effortLevels: EffortLevel[];
  current: ReasoningModelDefault;
  onChange: (modelId: string, value: ReasoningModelDefault) => void;
}

function ReasoningModelRow({ modelId, modelLabel, supportsReasoning, effortLevels, current, onChange }: ReasoningModelRowProps) {
  const visibleEffortOptions = EFFORT_OPTIONS.filter(o => effortLevels.includes(o.value));

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 py-3 border-b border-border last:border-0">
      {/* Model name + badge */}
      <div className="flex items-center gap-2 min-w-0 sm:w-52 flex-shrink-0">
        <span className="text-xs text-[var(--text)] truncate font-mono">{modelLabel}</span>
        {supportsReasoning ? (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/15 text-purple-400 border border-purple-500/30 flex-shrink-0">
            <Brain size={9} />
            Reasoning
          </span>
        ) : (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-border text-muted flex-shrink-0">
            None
          </span>
        )}
      </div>

      {/* Effort level dropdown */}
      <div className="flex items-center gap-2 flex-1">
        <select
          value={current.effort}
          onChange={e => onChange(modelId, { ...current, effort: e.target.value as EffortLevel })}
          disabled={!supportsReasoning || visibleEffortOptions.length === 0}
          className="text-xs bg-bg border border-border rounded px-2 py-1 text-[var(--text)] focus:border-accent outline-none disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {visibleEffortOptions.length === 0 ? (
            <option value="medium">—</option>
          ) : (
            visibleEffortOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))
          )}
        </select>

        {/* Override radio group */}
        <div className="flex gap-1">
          {OVERRIDE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              title={opt.description}
              onClick={() => onChange(modelId, { ...current, override: opt.value })}
              className={`px-2 py-1 text-[11px] rounded border transition-colors ${
                current.override === opt.value
                  ? 'bg-accent text-white border-accent'
                  : 'bg-bg text-muted border-border hover:border-accent/40 hover:text-[var(--text)]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReasoningDefaultsSection() {
  const toast = useGlobalToast();
  const { workspaceId } = useWorkspace();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // All models from direction/models
  const [allModels, setAllModels] = useState<DisplayModelOption[]>([]);
  // Current display settings (for fetching/saving reasoningDefaults)
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings | null>(null);
  // Local state for global toggle
  const [globalAutoEnable, setGlobalAutoEnable] = useState(false);
  // Per-model defaults keyed by modelId
  const [modelDefaults, setModelDefaults] = useState<Record<string, ReasoningModelDefault>>({});

  useEffect(() => {
    Promise.all([
      apiFetch<DisplaySettings>('/api/settings/display'),
      apiFetch<{ models: DisplayModelOption[] }>(`/api/direction/models${workspaceId ? `?workspaceId=${workspaceId}` : ''}`),
    ]).then(([displayData, modelData]) => {
      setDisplaySettings(displayData);
      setAllModels(modelData.models);
      const rd = displayData.reasoningDefaults ?? { globalAutoEnable: false, models: {} };
      setGlobalAutoEnable(rd.globalAutoEnable);
      setModelDefaults(rd.models);
    }).catch(() => { }).finally(() => setLoading(false));
  }, [workspaceId]);

  // Models that support reasoning — filter list for the table
  const reasoningModels = useMemo(() => {
    return allModels.filter(m => {
      const id = m.id.toLowerCase();
      // Claude 4.x, OpenAI o-series, or native CoT keywords
      return /^claude-[a-z]+-4[-.]/.test(id)
        || /^o\d/i.test(id.includes('/') ? id.split('/').pop()! : id)
        || /think|r1\b|qwq|reasoning/.test(id);
    });
  }, [allModels]);

  const getEffortLevelsForModel = (modelId: string): EffortLevel[] => {
    const id = modelId.toLowerCase();
    if (/^claude-[a-z]+-4[-.]/.test(id)) {
      return /opus/i.test(id) ? ['low', 'medium', 'high', 'max'] : ['low', 'medium', 'high'];
    }
    if (/^o\d/i.test(id.includes('/') ? id.split('/').pop()! : id)) {
      return ['low', 'medium', 'high'];
    }
    return [];
  };

  const handleModelChange = (modelId: string, value: ReasoningModelDefault) => {
    setModelDefaults(prev => ({ ...prev, [modelId]: value }));
  };

  const handleSave = async () => {
    if (!displaySettings) return;
    setSaving(true);
    setSaved(false);
    try {
      const rd: ReasoningDefaults = { globalAutoEnable, models: modelDefaults };
      await apiFetch('/api/settings/display', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultModel: displaySettings.defaultModel,
          itemsPerPage: displaySettings.itemsPerPage,
          reasoningDefaults: rd,
        }),
      });
      setDisplaySettings(prev => prev ? { ...prev, reasoningDefaults: rd } : prev);
      setSaved(true);
      toast.show('Reasoning defaults saved', 'success');
      setTimeout(() => setSaved(false), 2000);
    } catch {
      toast.show('Failed to save reasoning defaults', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-panel p-5">
        <div className="flex items-center gap-2 text-muted text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading reasoning defaults...
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-panel p-5">
      {/* Card header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Brain size={15} className="text-accent" />
          <span className="text-sm font-semibold text-[var(--text)]">Reasoning Defaults</span>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {saving ? (
            <Loader2 size={12} className="animate-spin" />
          ) : saved ? (
            <Check size={12} />
          ) : (
            <Save size={12} />
          )}
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>

      {/* Global toggle */}
      <div className="flex items-center justify-between py-3 border-b border-border mb-1">
        <div>
          <p className="text-xs font-medium text-[var(--text)]">Always enable reasoning for capable models</p>
          <p className="text-[11px] text-muted mt-0.5">Default for all models without individual overrides</p>
        </div>
        <ToggleSwitch checked={globalAutoEnable} onChange={() => setGlobalAutoEnable(v => !v)} />
      </div>

      {/* Per-model defaults table */}
      {reasoningModels.length === 0 ? (
        <p className="text-xs text-muted py-4 text-center">No reasoning-capable models found. Install an API key for Claude 4.x, OpenAI o-series, or other reasoning models.</p>
      ) : (
        <div>
          {/* Table header */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted sm:w-52 flex-shrink-0">Model</span>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
              <span>Default Effort</span>
              <span className="ml-2">Override</span>
            </div>
          </div>

          {reasoningModels.map(model => {
            const effortLevels = getEffortLevelsForModel(model.id);
            const current = modelDefaults[model.id] ?? {
              effort: (effortLevels[1] ?? effortLevels[0] ?? 'medium') as EffortLevel,
              override: 'auto' as const,
            };
            return (
              <ReasoningModelRow
                key={model.id}
                modelId={model.id}
                modelLabel={model.label}
                supportsReasoning={effortLevels.length > 0}
                effortLevels={effortLevels}
                current={current}
                onChange={handleModelChange}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
