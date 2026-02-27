import { useState, useEffect, useCallback } from 'react';
import { User, Key, Save, Loader2, Trash2, Plus, Eye, EyeOff, Check, Mail, AlertTriangle, Zap, Globe, CheckCircle2, XCircle, Layers, Github, Keyboard, CreditCard, ExternalLink, Download, Crown, Users, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useTheme, type ThemeMode } from '../contexts/ThemeContext';
import { useDirectionLayer } from '../hooks/useDirectionLayer';
import { apiFetch, clearTokens } from '../lib/apiFetch';
import GitHubSettingsPanel from './GitHubSettingsPanel';
import { modLabel } from '../hooks/useHotkeys';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SettingsTab = 'direction' | 'providers' | 'github' | 'shortcuts' | 'account' | 'billing';

interface ProfileData {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

interface NotificationPreferences {
  [eventType: string]: { inApp: boolean; email: boolean };
}

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

interface DisplaySettings {
  defaultModel: string;
  itemsPerPage: number;
}

interface ModelOption {
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
}

interface ModelTestResult {
  modelId: string;
  ok: boolean;
  latencyMs?: number;
  response?: string;
  error?: string;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  review_request: 'Review Requests',
  spec_approved: 'Spec Approved',
  spec_rejected: 'Spec Rejected',
  pipeline_completed: 'Pipeline Completed',
  budget_alert: 'Budget Alerts',
  mention: 'Mentions',
};

// ─── Direction Stack Layer Config ────────────────────────────────────────────

const LAYER_INFO: Record<1 | 2 | 3, { title: string; description: string; placeholder: string }> = {
  1: {
    title: 'L1 — Global Standards',
    description: 'Engineering principles, coding style, and preferences that apply to all projects.',
    placeholder: 'e.g. "Always use TypeScript strict mode. Prefer functional components. Use Tailwind for styling."',
  },
  2: {
    title: 'L2 — Domain Knowledge',
    description: 'Industry concepts, business rules, and domain-specific patterns.',
    placeholder: 'e.g. "This is a fintech product. Follow PCI-DSS compliance. Use cents for monetary values."',
  },
  3: {
    title: 'L3 — Project Context',
    description: 'Tech stack, architecture, and key constraints for this specific project.',
    placeholder: 'e.g. "React + Express app. PostgreSQL database. Deployed on Vercel."',
  },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function SettingsPanel({ initialTab }: { initialTab?: SettingsTab } = {}) {
  const { workspaceId } = useWorkspace();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'direction');

  // Sync tab when initialTab prop changes (e.g. navigating from ? hotkey)
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  // Direction layer hooks — always call (hooks can't be conditional)
  const l1 = useDirectionLayer(workspaceId, 1, { skipValidation: true });
  const l2 = useDirectionLayer(workspaceId, 2, { skipValidation: true });
  const l3 = useDirectionLayer(workspaceId, 3, { skipValidation: true });
  const directionDirty = l1.isDirty || l2.isDirty || l3.isDirty;

  const TABS: { id: SettingsTab; label: string; icon: typeof Layers }[] = [
    { id: 'direction', label: 'Direction Stack', icon: Layers },
    { id: 'providers', label: 'Model & Providers', icon: Zap },
    { id: 'github', label: 'GitHub', icon: Github },
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
    { id: 'account', label: 'Account', icon: User },
    { id: 'billing', label: 'Billing', icon: CreditCard },
  ];

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 sm:p-6 border-b border-border shrink-0">
        <h1 className="text-lg font-semibold text-[var(--text)]">Settings</h1>
        <p className="text-xs text-muted mt-1">Direction stack, providers, integrations, and account</p>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Tab sidebar */}
        <nav className="w-48 shrink-0 border-r border-border bg-panel p-2 hidden sm:block">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${
                activeTab === id
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:text-[var(--text)] hover:bg-bg'
              }`}
            >
              <Icon size={16} />
              <span className="flex-1 text-left">{label}</span>
              {id === 'direction' && directionDirty && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-warning/15 text-warning">
                  Unsaved
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Mobile tab bar */}
        <div className="sm:hidden flex border-b border-border bg-panel shrink-0 overflow-x-auto">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center justify-center gap-1 px-3 py-2 text-xs whitespace-nowrap transition-colors ${
                activeTab === id
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-muted'
              }`}
            >
              <Icon size={14} />
              {label}
              {id === 'direction' && directionDirty && (
                <span className="ml-1 px-1 py-0.5 text-[9px] font-medium rounded bg-warning/15 text-warning">
                  Unsaved
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {activeTab === 'direction' && <DirectionStackSection l1={l1} l2={l2} l3={l3} />}
          {activeTab === 'providers' && <ProvidersAndDisplaySection />}
          {activeTab === 'github' && <GitHubSettingsPanel />}
          {activeTab === 'shortcuts' && <ShortcutsSection />}
          {activeTab === 'account' && <AccountSection />}
          {activeTab === 'billing' && <BillingSection />}
        </div>
      </div>
    </div>
  );
}

// ─── Direction Stack Section ─────────────────────────────────────────────────

interface DirectionLayerHook {
  content: string;
  setContent: (v: string) => void;
  isSaving: boolean;
  isDirty: boolean;
}

function DirectionStackSection({ l1, l2, l3 }: { l1: DirectionLayerHook; l2: DirectionLayerHook; l3: DirectionLayerHook }) {
  const layers = [
    { n: 1 as const, hook: l1 },
    { n: 2 as const, hook: l2 },
    { n: 3 as const, hook: l3 },
  ];

  return (
    <div className="max-w-2xl space-y-6">
      {/* Cascade explanation */}
      <div className="border border-border rounded p-3 bg-panel">
        <p className="text-xs text-muted">
          <span className="font-medium text-[var(--text)]">Direction Stack</span> — Context flows from L1 (global) through L3 (project-specific). Lower layers override higher ones, like CSS specificity. L4 (spec brief) and L5 (story annotations) are injected at runtime.
        </p>
      </div>

      {/* Layer editors */}
      {layers.map(({ n, hook }) => {
        const info = LAYER_INFO[n];
        return (
          <div key={n} className="border border-border rounded bg-bg">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div>
                <h3 className="text-sm font-medium text-[var(--text)]">{info.title}</h3>
                <p className="text-xs text-muted mt-0.5">{info.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                {hook.isDirty && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-warning/15 text-warning">
                    Unsaved
                  </span>
                )}
                {hook.isSaving && (
                  <Loader2 size={14} className="animate-spin text-accent" />
                )}
                {!hook.isDirty && !hook.isSaving && hook.content.trim() && (
                  <Check size={14} className="text-green-500" />
                )}
              </div>
            </div>
            <textarea
              value={hook.content}
              onChange={(e) => hook.setContent(e.target.value)}
              className="w-full p-4 text-sm bg-bg text-[var(--text)] border-none outline-none resize-none min-h-[120px]"
              placeholder={info.placeholder}
              rows={6}
            />
          </div>
        );
      })}
    </div>
  );
}

// ─── Providers & Display Section (merged) ────────────────────────────────────

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'claude-cli': 'Uses your Claude subscription via the claude CLI. No API key needed.',
  'anthropic': 'Direct API access to Claude models. Requires an Anthropic API key.',
  'openai-compat': 'Any OpenAI-compatible endpoint (OpenAI, Groq, Together, DeepSeek, Ollama, etc.).',
  'openrouter': 'Access 200+ models through a single API key.',
};

function ProvidersAndDisplaySection() {
  return (
    <div className="max-w-2xl space-y-8">
      <DisplaySection />
      <div className="border-t border-border pt-6">
        <ProvidersSection />
      </div>
    </div>
  );
}

// ─── Providers Section ──────────────────────────────────────────────────────

function ProvidersSection() {
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
        apiFetch<{ providers: ProviderStatus[] }>('/api/vault/keys/providers'),
        apiFetch<{ keys: ApiKeyEntry[] }>('/api/vault/keys'),
        workspaceId
          ? apiFetch<{ provider: string }>(`/api/vault/keys/default-provider?workspaceId=${workspaceId}`)
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
    setAdding(true);
    setAddError(null);
    try {
      await apiFetch('/api/vault/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
      fetchData();
    } catch (err: any) {
      setAddError(err.message || 'Failed to add key');
    } finally {
      setAdding(false);
    }
  };

  const removeKey = async (id: string) => {
    try {
      await apiFetch(`/api/vault/keys/${id}`, { method: 'DELETE' });
      fetchData();
    } catch {
      // silent
    }
  };

  const testConnection = async (providerId: string) => {
    setTestingProvider(providerId);
    setTestResult(null);
    try {
      const result = await apiFetch<{ ok: boolean; latencyMs: number; response: string }>('/api/vault/keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
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
            <div key={p.id} className={`border rounded p-4 transition-colors ${
              isDefault ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg'
            }`}>
              {/* Provider header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${p.configured ? 'bg-green-500' : 'bg-zinc-500'}`} />
                  <div>
                    <div className="flex items-center gap-2">
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
                <div className="flex items-center gap-2">
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
                <div className={`mt-3 px-3 py-2 rounded text-xs flex items-center gap-2 ${
                  testResult.ok
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

// ─── Display Section ─────────────────────────────────────────────────────────

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

function formatContextWindow(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(tokens % 1000000 === 0 ? 0 : 1)}M`;
  return `${(tokens / 1000).toFixed(0)}K`;
}

function ModelCard({ model, isSelected, isWorkspaceOverride, onSelect, onTest, testResult, isTesting }: {
  model: ModelOption;
  isSelected: boolean;
  isWorkspaceOverride: boolean;
  onSelect: () => void;
  onTest: () => void;
  testResult: ModelTestResult | null;
  isTesting: boolean;
}) {
  const speed = SPEED_LABELS[model.speedTier] ?? SPEED_LABELS.medium;
  const cost = COST_LABELS[model.costTier] ?? COST_LABELS.medium;

  return (
    <div
      className={`border rounded p-3 transition-colors cursor-pointer ${
        isSelected
          ? 'border-accent/60 bg-accent/5'
          : 'border-border bg-bg hover:border-accent/30'
      }`}
      onClick={onSelect}
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
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted">
            <span title="Context window">{formatContextWindow(model.contextWindow)} ctx</span>
            <span className={speed.color}>{speed.label}</span>
            <span className={cost.color}>${model.costTier === 'free' ? 'Free' : `${model.costPer1kInput.toFixed(4)}/${model.costPer1kOutput.toFixed(4)}`}</span>
          </div>
        </div>
        <button
          onClick={e => { e.stopPropagation(); onTest(); }}
          disabled={isTesting}
          className="flex items-center gap-1 px-2 py-1 text-[11px] border border-border rounded hover:border-accent/40 text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50 shrink-0"
          title="Send a test prompt to this model"
        >
          {isTesting ? <Loader2 size={10} className="animate-spin" /> : <Zap size={10} />}
          Test
        </button>
      </div>
      {testResult && testResult.modelId === model.id && (
        <div className={`mt-2 px-2 py-1.5 rounded text-[11px] flex items-center gap-1.5 ${
          testResult.ok
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

function DisplaySection() {
  const { mode, setMode } = useTheme();
  const { workspaceId } = useWorkspace();
  const [settings, setSettings] = useState<DisplaySettings | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [defaultModel, setDefaultModel] = useState('claude-sonnet-4-5-20250929');
  const [itemsPerPage, setItemsPerPage] = useState(20);

  // Per-workspace preferred model override
  const [workspaceModel, setWorkspaceModel] = useState<string | null>(null);
  const [workspaceModelInitial, setWorkspaceModelInitial] = useState<string | null>(null);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [savedWorkspace, setSavedWorkspace] = useState(false);

  // Test model state
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);

  useEffect(() => {
    const fetchPromises: Promise<any>[] = [
      apiFetch<DisplaySettings>('/api/settings/display'),
      apiFetch<{ models: ModelOption[]; defaultModel: string }>(`/api/direction/models${workspaceId ? `?workspaceId=${workspaceId}` : ''}`),
    ];
    // Fetch workspace L3 preferred model if workspace selected
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
    }).catch(() => {})
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
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  const saveWorkspaceModel = async (modelId: string | null) => {
    if (!workspaceId) return;
    setSavingWorkspace(true);
    setSavedWorkspace(false);
    try {
      // We need the current L3 content to save alongside
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

  const testModel = async (modelId: string) => {
    setTestingModel(modelId);
    setTestResult(null);
    try {
      const result = await apiFetch<{ ok: boolean; latencyMs: number; response: string }>('/api/direction/models/test', {
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

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading model settings...</div>;
  }

  const hasChanges = settings && (defaultModel !== settings.defaultModel || itemsPerPage !== settings.itemsPerPage);
  const effectiveModel = workspaceModel ?? defaultModel;

  // Group models by provider
  const modelsByProvider = models.reduce<Record<string, ModelOption[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {/* Theme */}
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">Theme</h2>
        <div className="flex gap-2">
          {(['light', 'dark', 'system'] as ThemeMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-4 py-2 text-sm rounded border transition-colors capitalize ${
                mode === m
                  ? 'bg-accent/10 border-accent text-accent'
                  : 'border-border text-muted hover:text-[var(--text)] hover:border-accent/50'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Default Model (global) */}
      <div className="border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-1">Default Model</h2>
        <p className="text-xs text-muted mb-3">Global default when no workspace override is set</p>
        <select
          value={defaultModel}
          onChange={e => setDefaultModel(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
        >
          {models.map(m => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.provider}) — {formatContextWindow(m.contextWindow)} ctx, {SPEED_LABELS[m.speedTier]?.label}, {COST_LABELS[m.costTier]?.label} cost
            </option>
          ))}
        </select>
      </div>

      {/* Per-workspace preferred model override */}
      {workspaceId && (
        <div className="border-t border-border pt-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-[var(--text)]">Workspace Model Override</h2>
            {savedWorkspace && (
              <span className="flex items-center gap-1 text-xs text-green-500"><Check size={12} /> Saved</span>
            )}
          </div>
          <p className="text-xs text-muted mb-3">
            Override the global default for this workspace. Persists to the Direction Stack L3.
          </p>
          <div className="flex gap-2">
            <select
              value={workspaceModel ?? ''}
              onChange={e => {
                const val = e.target.value || null;
                setWorkspaceModel(val);
              }}
              disabled={savingWorkspace}
              className="flex-1 px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            >
              <option value="">Use global default ({models.find(m => m.id === defaultModel)?.label ?? defaultModel})</option>
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.provider}) — {formatContextWindow(m.contextWindow)} ctx
                </option>
              ))}
            </select>
            <button
              onClick={() => saveWorkspaceModel(workspaceModel)}
              disabled={savingWorkspace || workspaceModel === workspaceModelInitial}
              className="flex items-center gap-1.5 px-3 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors shrink-0"
            >
              {savingWorkspace ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </div>
      )}

      {/* Model catalog with test buttons */}
      <div className="border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-1">Available Models</h2>
        <p className="text-xs text-muted mb-3">Click a model to set it as the {workspaceId ? 'workspace' : 'global'} default. Use Test to verify connectivity.</p>
        <div className="space-y-4">
          {Object.entries(modelsByProvider).map(([provider, providerModels]) => (
            <div key={provider}>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">{provider}</h3>
              <div className="space-y-1.5">
                {providerModels.map(m => (
                  <ModelCard
                    key={m.id}
                    model={m}
                    isSelected={m.id === effectiveModel}
                    isWorkspaceOverride={m.id === workspaceModel}
                    onSelect={() => {
                      if (workspaceId) {
                        setWorkspaceModel(m.id);
                        saveWorkspaceModel(m.id);
                      } else {
                        setDefaultModel(m.id);
                      }
                    }}
                    onTest={() => testModel(m.id)}
                    testResult={testResult}
                    isTesting={testingModel === m.id}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Items per page */}
      <div className="border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">Items Per Page</h2>
        <select
          value={itemsPerPage}
          onChange={e => setItemsPerPage(Number(e.target.value))}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
        >
          {[10, 20, 30, 50, 100].map(n => (
            <option key={n} value={n}>{n} items</option>
          ))}
        </select>
        <p className="text-xs text-muted mt-1">Number of items shown per page in lists and archives</p>
      </div>

      {/* Save display settings button */}
      <button
        onClick={saveDisplay}
        disabled={saving || !hasChanges}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? 'Saved' : 'Save Display Settings'}
      </button>
    </div>
  );
}

// ─── Billing Section ─────────────────────────────────────────────────────────

interface BillingStatus {
  plan: string;
  subscription: {
    status: string;
    plan: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    stripeSubscriptionId: string | null;
  } | null;
  seats: { used: number; limit: number | null };
  plans: Record<string, { name: string; priceMonthly: number; features: string[] }>;
  stripeConfigured: boolean;
}

interface Invoice {
  id: string;
  number: string | null;
  status: string;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

const PLAN_ICONS: Record<string, typeof Zap> = {
  free: Zap,
  solo: Zap,
  pro: Crown,
  team: Users,
};

const PLAN_COLORS: Record<string, string> = {
  free: 'text-muted border-border bg-bg',
  solo: 'text-accent border-accent/40 bg-accent/5',
  pro: 'text-purple-400 border-purple-400/40 bg-purple-400/5',
  team: 'text-amber-400 border-amber-400/40 bg-amber-400/5',
};

function BillingSection() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showAllInvoices, setShowAllInvoices] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<BillingStatus>('/api/billing/status'),
      apiFetch<{ invoices: Invoice[] }>('/api/billing/invoices'),
    ])
      .then(([statusData, invoiceData]) => {
        setStatus(statusData);
        setInvoices(invoiceData.invoices);
      })
      .catch(() => setError('Failed to load billing information'))
      .finally(() => setLoading(false));
  }, []);

  const openPortal = async () => {
    setPortalLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ url?: string; error?: string }>('/api/billing/portal', {
        method: 'POST',
      });
      if (res.url) {
        window.open(res.url, '_blank');
      } else {
        setError(res.error || 'Failed to open billing portal');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to open billing portal');
    } finally {
      setPortalLoading(false);
    }
  };

  const handleCheckout = async (planId: string) => {
    setCheckoutLoading(planId);
    setError(null);
    try {
      const res = await apiFetch<{ url?: string; error?: string }>('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planId }),
      });
      if (res.url) {
        window.location.href = res.url;
      } else {
        setError(res.error || 'Failed to start checkout');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start checkout');
    } finally {
      setCheckoutLoading(null);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading billing...</div>;
  }

  if (!status) {
    return <p className="text-sm text-red-500">{error || 'Failed to load billing'}</p>;
  }

  const currentPlan = status.plan;
  const planInfo = status.plans[currentPlan];
  const PlanIcon = PLAN_ICONS[currentPlan] || Zap;
  const planColor = PLAN_COLORS[currentPlan] || PLAN_COLORS.free;
  const isActive = status.subscription?.status === 'active';
  const isPaid = currentPlan !== 'free';
  const renewalDate = status.subscription?.currentPeriodEnd
    ? new Date(status.subscription.currentPeriodEnd)
    : null;

  const visibleInvoices = showAllInvoices ? invoices : invoices.slice(0, 5);

  return (
    <div className="max-w-2xl space-y-6">
      {/* Current Plan Badge */}
      <div className={`border rounded-lg p-5 ${planColor}`}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg border border-current/20 flex items-center justify-center">
              <PlanIcon size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold">{planInfo?.name || 'Free'} Plan</h2>
                {isActive && isPaid && (
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-green-500/15 text-green-500">
                    Active
                  </span>
                )}
                {status.subscription?.status === 'past_due' && (
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-amber-500/15 text-amber-500">
                    Past Due
                  </span>
                )}
                {status.subscription?.status === 'canceled' && (
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-red-500/15 text-red-500">
                    Canceled
                  </span>
                )}
              </div>
              {isPaid && (
                <p className="text-sm mt-0.5 opacity-80">${planInfo?.priceMonthly}/month</p>
              )}
              {!isPaid && (
                <p className="text-xs mt-0.5 opacity-70">Upgrade to unlock pipeline execution</p>
              )}
            </div>
          </div>
          {isPaid && status.stripeConfigured && (
            <button
              onClick={openPortal}
              disabled={portalLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-current/20 rounded hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              {portalLoading ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
              Manage Billing
            </button>
          )}
        </div>

        {/* Subscription details */}
        {isPaid && (
          <div className="mt-4 grid grid-cols-2 gap-4 pt-4 border-t border-current/10">
            <div>
              <p className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Renewal Date</p>
              <p className="text-sm font-medium">
                {renewalDate ? renewalDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'N/A'}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Seats</p>
              <p className="text-sm font-medium">
                {status.seats.used} used{status.seats.limit ? ` / ${status.seats.limit} max` : ' (unlimited)'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Plan Comparison Table */}
      <div>
        <h3 className="text-sm font-semibold text-[var(--text)] mb-3">
          {isPaid ? 'Change Plan' : 'Upgrade Your Plan'}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {Object.entries(status.plans).map(([planId, plan]) => {
            const isCurrent = planId === currentPlan;
            const Icon = PLAN_ICONS[planId] || Zap;
            return (
              <div
                key={planId}
                className={`border rounded-lg p-4 flex flex-col ${
                  isCurrent
                    ? 'border-accent/60 bg-accent/5'
                    : 'border-border bg-bg hover:border-accent/30'
                } transition-colors`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Icon size={16} className={isCurrent ? 'text-accent' : 'text-muted'} />
                  <span className="text-sm font-medium text-[var(--text)]">{plan.name}</span>
                  {isCurrent && (
                    <span className="px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded bg-accent/15 text-accent">
                      Current
                    </span>
                  )}
                </div>
                <div className="mb-3">
                  <span className="text-lg font-bold text-[var(--text)]">
                    {plan.priceMonthly === 0 ? 'Free' : `$${plan.priceMonthly}`}
                  </span>
                  {plan.priceMonthly > 0 && <span className="text-xs text-muted">/mo</span>}
                </div>
                <ul className="flex-1 space-y-1.5 mb-4">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-start gap-1.5 text-[11px] text-muted">
                      <Check size={10} className="mt-0.5 text-green-500 shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                {!isCurrent && planId !== 'free' && status.stripeConfigured && (
                  <button
                    onClick={() => handleCheckout(planId)}
                    disabled={!!checkoutLoading}
                    className="w-full py-1.5 rounded text-xs font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
                  >
                    {checkoutLoading === planId ? (
                      <span className="flex items-center justify-center gap-1">
                        <Loader2 size={10} className="animate-spin" /> Redirecting...
                      </span>
                    ) : (
                      isPaid ? `Switch to ${plan.name}` : `Get ${plan.name}`
                    )}
                  </button>
                )}
                {isCurrent && (
                  <div className="w-full py-1.5 rounded text-xs font-medium text-center text-accent bg-accent/10">
                    Current Plan
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {!status.stripeConfigured && (
          <p className="text-xs text-muted mt-3 flex items-center gap-1.5">
            <AlertTriangle size={12} className="text-amber-500" />
            Stripe is not configured. Set STRIPE_SECRET_KEY in backend/.env to enable billing.
          </p>
        )}
      </div>

      {/* Invoice History */}
      <div className="border-t border-border pt-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--text)]">Invoice History</h3>
          {isPaid && status.stripeConfigured && (
            <button
              onClick={openPortal}
              disabled={portalLoading}
              className="text-xs text-accent hover:text-accent/80 transition-colors"
            >
              View all in Stripe
            </button>
          )}
        </div>

        {invoices.length === 0 ? (
          <div className="border border-border rounded p-6 text-center">
            <FileText size={24} className="mx-auto text-muted mb-2" />
            <p className="text-sm text-muted">No invoices yet</p>
            <p className="text-xs text-muted mt-1">Invoices will appear here after your first payment</p>
          </div>
        ) : (
          <div className="border border-border rounded overflow-hidden">
            <div className="grid grid-cols-[1fr_80px_80px_60px] gap-2 px-4 py-2 bg-bg text-[10px] text-muted font-medium uppercase tracking-wider border-b border-border">
              <span>Invoice</span>
              <span>Amount</span>
              <span>Date</span>
              <span className="text-right">Action</span>
            </div>
            {visibleInvoices.map(inv => (
              <div key={inv.id} className="grid grid-cols-[1fr_80px_80px_60px] gap-2 px-4 py-2.5 border-b border-border last:border-b-0 items-center">
                <div className="min-w-0">
                  <p className="text-sm text-[var(--text)] truncate">{inv.number || inv.id.slice(0, 16)}</p>
                  <p className="text-[10px] text-muted capitalize">{inv.status}</p>
                </div>
                <span className="text-sm text-[var(--text)]">
                  ${(inv.amountPaid / 100).toFixed(2)}
                </span>
                <span className="text-xs text-muted">
                  {inv.created ? new Date(inv.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                </span>
                <div className="flex justify-end">
                  {inv.invoicePdf && (
                    <a
                      href={inv.invoicePdf}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1 text-muted hover:text-accent transition-colors"
                      title="Download PDF"
                    >
                      <Download size={14} />
                    </a>
                  )}
                  {!inv.invoicePdf && inv.hostedInvoiceUrl && (
                    <a
                      href={inv.hostedInvoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1 text-muted hover:text-accent transition-colors"
                      title="View invoice"
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </div>
            ))}
            {invoices.length > 5 && (
              <button
                onClick={() => setShowAllInvoices(!showAllInvoices)}
                className="w-full flex items-center justify-center gap-1 px-4 py-2 text-xs text-muted hover:text-[var(--text)] transition-colors border-t border-border"
              >
                {showAllInvoices ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {showAllInvoices ? 'Show less' : `Show all ${invoices.length} invoices`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Cancel Subscription */}
      {isPaid && isActive && status.stripeConfigured && (
        <div className="border-t border-border pt-6">
          <h3 className="text-sm font-semibold text-[var(--text)] mb-2">Cancel Subscription</h3>
          {!showCancelConfirm ? (
            <div>
              <p className="text-xs text-muted mb-3">
                Cancel your subscription. You'll retain access to your current plan until the end of your billing period.
              </p>
              <button
                onClick={() => setShowCancelConfirm(true)}
                className="px-4 py-2 text-sm text-red-500 border border-red-500/30 rounded hover:bg-red-500/5 transition-colors"
              >
                Cancel Subscription
              </button>
            </div>
          ) : (
            <div className="border border-red-500/30 rounded p-4 space-y-3 bg-red-500/5">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="text-red-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-[var(--text)]">Are you sure?</p>
                  <p className="text-xs text-muted mt-1">
                    Your subscription will remain active until{' '}
                    <span className="font-medium text-[var(--text)]">
                      {renewalDate ? renewalDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'the end of your billing period'}
                    </span>
                    . After that, your account will revert to the Free plan. No further charges will be made.
                  </p>
                  <p className="text-xs text-muted mt-2">
                    You can manage cancellation through the Stripe billing portal, which allows you to cancel immediately or at the end of the period.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={openPortal}
                  disabled={portalLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {portalLoading ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                  Continue to Cancel
                </button>
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  className="px-4 py-2 text-sm text-muted hover:text-[var(--text)] transition-colors"
                >
                  Keep Plan
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <AlertTriangle size={12} />
          {error}
        </p>
      )}
    </div>
  );
}

// ─── Account Section (Profile + Notifications + Danger Zone) ─────────────────

function AccountSection() {
  return (
    <div className="max-w-lg space-y-8">
      <ProfileSection />
      <div className="border-t border-border pt-6">
        <NotificationsSection />
      </div>
      <div className="border-t border-border pt-6">
        <AccountDeletionSection />
      </div>
    </div>
  );
}

// ─── Profile Section ─────────────────────────────────────────────────────────

function ProfileSection() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState('');

  // Password change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);

  // Email verification resend
  const [verificationSending, setVerificationSending] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ user: { id: string; email: string; displayName: string } }>('/api/auth/me')
      .then(data => {
        setProfile({ id: data.user.id, email: data.user.email, displayName: data.user.displayName, avatarUrl: null });
        setDisplayName(data.user.displayName);
      })
      .catch(() => setError('Failed to load profile'))
      .finally(() => setLoading(false));
  }, []);

  const saveProfile = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    setPasswordSaving(true);
    setPasswordError(null);
    setPasswordSaved(false);
    try {
      await apiFetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setPasswordSaved(true);
      setCurrentPassword('');
      setNewPassword('');
      setTimeout(() => setPasswordSaved(false), 2000);
    } catch (err: any) {
      setPasswordError(err.message || 'Failed to change password');
    } finally {
      setPasswordSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading profile...</div>;
  }

  const hasProfileChanges = profile && displayName !== profile.displayName;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">Profile</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-muted mb-1">Email</label>
            <input
              type="email"
              value={user?.email ?? ''}
              disabled
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded opacity-60 cursor-not-allowed"
            />
            {user && !user.emailVerified && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <Mail size={12} className="text-amber-500" />
                <span className="text-amber-400">Email not verified</span>
                <button
                  onClick={async () => {
                    if (!user.email) return;
                    setVerificationSending(true);
                    setVerificationError(null);
                    setVerificationSent(false);
                    try {
                      await apiFetch('/api/auth/resend-verification', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: user.email }),
                      });
                      setVerificationSent(true);
                    } catch (err: any) {
                      setVerificationError(err.message || 'Failed to resend');
                    } finally {
                      setVerificationSending(false);
                    }
                  }}
                  disabled={verificationSending || verificationSent}
                  className="text-amber-400 hover:text-amber-300 underline underline-offset-2 disabled:opacity-50"
                >
                  {verificationSending ? 'Sending...' : verificationSent ? 'Sent!' : 'Resend verification'}
                </button>
                {verificationError && <span className="text-red-400">{verificationError}</span>}
              </div>
            )}
            {user?.emailVerified && (
              <div className="mt-2 flex items-center gap-1 text-xs text-green-500">
                <Check size={12} /> Verified
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs text-muted mb-1">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            onClick={saveProfile}
            disabled={saving || !hasProfileChanges}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
            {saved ? 'Saved' : 'Save Profile'}
          </button>
        </div>
      </div>

      {/* Password Change */}
      <div className="border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">Change Password</h2>
        <div className="space-y-4">
          <div className="relative">
            <label className="block text-xs text-muted mb-1">Current Password</label>
            <input
              type={showPasswords ? 'text' : 'password'}
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 pr-10 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPasswords(!showPasswords)}
              className="absolute right-2 top-6 p-1 text-muted hover:text-[var(--text)]"
            >
              {showPasswords ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>

          <div>
            <label className="block text-xs text-muted mb-1">New Password</label>
            <input
              type={showPasswords ? 'text' : 'password'}
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="Min 6 characters"
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
          </div>

          {passwordError && <p className="text-xs text-red-500">{passwordError}</p>}

          <button
            onClick={changePassword}
            disabled={passwordSaving || !currentPassword || newPassword.length < 6}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {passwordSaving ? <Loader2 size={14} className="animate-spin" /> : passwordSaved ? <Check size={14} /> : <Save size={14} />}
            {passwordSaved ? 'Password Changed' : 'Change Password'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Notifications Section ───────────────────────────────────────────────────

function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotificationPreferences>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiFetch<{ preferences: NotificationPreferences }>('/api/notifications/preferences')
      .then(data => setPrefs(data.preferences))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = (eventType: string, channel: 'inApp' | 'email') => {
    setPrefs(prev => ({
      ...prev,
      [eventType]: {
        ...prev[eventType],
        [channel]: !prev[eventType]?.[channel],
      },
    }));
  };

  const savePrefs = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await apiFetch('/api/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: prefs }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading preferences...</div>;
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-[var(--text)]">Notification Preferences</h2>
      <p className="text-xs text-muted">Choose which events trigger notifications and how they are delivered.</p>

      <div className="border border-border rounded overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[1fr_60px_60px] gap-2 px-4 py-2 bg-bg text-xs text-muted font-medium border-b border-border">
          <span>Event</span>
          <span className="text-center">In-App</span>
          <span className="text-center">Email</span>
        </div>

        {/* Rows */}
        {Object.entries(EVENT_TYPE_LABELS).map(([eventType, label]) => (
          <div key={eventType} className="grid grid-cols-[1fr_60px_60px] gap-2 px-4 py-2.5 border-b border-border last:border-b-0 items-center">
            <span className="text-sm text-[var(--text)]">{label}</span>
            <div className="flex justify-center">
              <ToggleSwitch
                checked={prefs[eventType]?.inApp ?? true}
                onChange={() => toggle(eventType, 'inApp')}
              />
            </div>
            <div className="flex justify-center">
              <ToggleSwitch
                checked={prefs[eventType]?.email ?? true}
                onChange={() => toggle(eventType, 'email')}
              />
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={savePrefs}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? 'Saved' : 'Save Preferences'}
      </button>
    </div>
  );
}

// ─── Account Deletion Section ─────────────────────────────────────────────────

function AccountDeletionSection() {
  const [showConfirm, setShowConfirm] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = password.length > 0 && confirmText === 'DELETE';

  const handleDelete = async () => {
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await apiFetch('/api/auth/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      clearTokens();
      window.location.href = '/';
    } catch (err: any) {
      setError(err.message || 'Failed to delete account');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-red-500 mb-2">Danger Zone</h2>
        <p className="text-xs text-muted">
          Permanently delete your account and all associated data. This action is irreversible.
        </p>
      </div>

      <div className="border border-red-500/30 rounded p-4 space-y-4 bg-red-500/5">
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} className="text-red-500 shrink-0 mt-0.5" />
          <div className="text-sm text-[var(--text)]">
            <p className="font-medium">Delete your account</p>
            <p className="text-xs text-muted mt-1">
              This will permanently delete your user account, all workspaces you own, specs, direction layers,
              pipeline runs, WAL events, API keys, team memberships, and cancel your subscription if active.
              This cannot be undone.
            </p>
          </div>
        </div>

        {!showConfirm ? (
          <button
            onClick={() => setShowConfirm(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
          >
            <Trash2 size={14} />
            Delete my account
          </button>
        ) : (
          <div className="space-y-3 border-t border-red-500/20 pt-4">
            <div>
              <label className="block text-xs text-muted mb-1">Enter your password to confirm</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Your current password"
                className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-red-500 outline-none"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-xs text-muted mb-1">
                Type <span className="font-mono font-bold text-red-400">DELETE</span> to confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder="DELETE"
                className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-red-500 outline-none font-mono"
              />
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex gap-2">
              <button
                onClick={handleDelete}
                disabled={!canDelete || deleting}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {deleting ? 'Deleting...' : 'Permanently delete my account'}
              </button>
              <button
                onClick={() => { setShowConfirm(false); setPassword(''); setConfirmText(''); setError(null); }}
                className="px-4 py-2 text-sm text-muted hover:text-[var(--text)] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Shortcuts Section ───────────────────────────────────────────────────────

const SHORTCUT_GROUPS = (() => {
  const mod = modLabel();
  return [
    {
      category: 'Navigation',
      shortcuts: [
        { keys: [`${mod}`, '1'], description: 'Go to Hub' },
        { keys: [`${mod}`, '2'], description: 'Go to Forge' },
        { keys: [`${mod}`, '3'], description: 'Go to Run View' },
        { keys: [`${mod}`, '4'], description: 'Go to Settings' },
      ],
    },
    {
      category: 'Specs',
      shortcuts: [
        { keys: [`${mod}`, 'N'], description: 'New spec in Spec Forge' },
        { keys: [`${mod}`, 'Enter'], description: 'Approve selected spec' },
        { keys: [`${mod}`, 'Backspace'], description: 'Reject selected spec' },
      ],
    },
    {
      category: 'Pipeline',
      shortcuts: [
        { keys: [`${mod}`, 'Shift', 'R'], description: 'Trigger pipeline run' },
        { keys: [`${mod}`, '.'], description: 'Cancel active run' },
      ],
    },
    {
      category: 'General',
      shortcuts: [
        { keys: [`${mod}`, 'K'], description: 'Open command palette' },
        { keys: ['?'], description: 'Open shortcuts' },
        { keys: [`${mod}`, '/'], description: 'Open shortcuts' },
        { keys: ['Esc'], description: 'Close panel / modal' },
      ],
    },
  ];
})();

function ShortcutsSection() {
  return (
    <div className="max-w-lg space-y-5">
      <h2 className="text-sm font-semibold text-[var(--text)]">Keyboard Shortcuts</h2>
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.category}>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">
            {group.category}
          </h3>
          <div className="space-y-1">
            {group.shortcuts.map((shortcut, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-bg/50"
              >
                <span className="text-sm text-[var(--text)]">{shortcut.description}</span>
                <div className="flex items-center gap-0.5 shrink-0 ml-4">
                  {shortcut.keys.map((key, ki) => (
                    <kbd
                      key={ki}
                      className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-[11px] font-mono text-muted bg-bg border border-border rounded"
                    >
                      {key}
                    </kbd>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Toggle Switch ───────────────────────────────────────────────────────────

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={`relative w-9 h-5 rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-border'
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          checked ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}
