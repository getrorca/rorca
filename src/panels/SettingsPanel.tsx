import { useState, useEffect, useCallback, useRef } from 'react';
import { User, Key, Save, Loader2, Trash2, Plus, Eye, EyeOff, Check, Mail, AlertTriangle, Zap, Globe, CheckCircle2, XCircle, Layers, Github, Keyboard, Cpu, ChevronDown, BookOpen, SlidersHorizontal, Crown, Users, ChevronUp, Download, ExternalLink, FileText, CreditCard } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useTheme, type ThemeMode } from '../contexts/ThemeContext';
import { useDirectionLayer } from '../hooks/useDirectionLayer';
import { apiFetch, clearTokens, BASE_URL } from '../lib/apiFetch';
import GitHubSettingsPanel from './GitHubSettingsPanel';
import { modLabel } from '../hooks/useHotkeys';
import OpenCodeSetupGuide from '../components/OpenCodeSetupGuide';
import { useActiveSettingsTab } from '../routes';
import PersonasSection from '../components/PersonasSection';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SettingsTab = 'direction' | 'providers' | 'github' | 'shortcuts' | 'account' | 'billing' | 'personas';

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

export default function SettingsPanel() {
  const { workspaceId } = useWorkspace();
  const activeTab = useActiveSettingsTab();

  // Direction layer hooks — always call (hooks can't be conditional)
  const l1 = useDirectionLayer(workspaceId, 1, { skipValidation: true });
  const l2 = useDirectionLayer(workspaceId, 2, { skipValidation: true });
  const l3 = useDirectionLayer(workspaceId, 3, { skipValidation: true });

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <div className="flex-1 p-4 sm:p-6 mx-auto w-full max-w-4xl">
        {activeTab === 'direction' && <DirectionStackSection l1={l1} l2={l2} l3={l3} />}
        {activeTab === 'providers' && <ProvidersAndDisplaySection />}
        {activeTab === 'github' && <GitHubSettingsPanel />}
        {activeTab === 'shortcuts' && <ShortcutsSection />}
        {activeTab === 'account' && <AccountSection />}
        {activeTab === 'billing' && <BillingSection />}
        {activeTab === 'personas' && <PersonasSection />}
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
  'openrouter': 'Access 200+ models through a single API key. Configure in Execution Engine above.',
};

function ProvidersAndDisplaySection() {
  return (
    <div className="max-w-2xl space-y-8">
      <DisplaySection />
      <div className="border-t border-border pt-6">
        <ExecutionEngineSection />
      </div>
      <div className="border-t border-border pt-6">
        <ModelRoutingSection />
      </div>
      <div className="border-t border-border pt-6">
        <ProvidersSection />
      </div>
    </div>
  );
}

// ─── Execution Engine Section (OC-009) ───────────────────────────────────────

interface AgentConfig {
  agentType: 'claude' | 'opencode' | 'codex';
  agentModel: string | null;
  opencodeInstalled: boolean | null;
  opencodeVersion: string | null;
  codexInstalled: boolean | null;
  codexVersion: string | null;
  copilotConnected: boolean;
  copilotUsername: string | null;
}

interface CopilotStatus {
  connected: boolean;
  githubUsername: string | null;
  connectedAt: string | null;
}

interface OpenCodeModelEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
}

interface OllamaStatus {
  available: boolean;
  models: Array<{ id: string; name: string; size: number; parameterSize: string }>;
  error?: string;
}

// ─── Claude Auth Status (OC-025) ────────────────────────────────────────────

interface ClaudeAuthState {
  connected: boolean;
  email?: string;
  tier?: string;
  expiresAt?: number;
  cliInstalled: boolean;
  cliVersion?: string;
}

function ClaudeAuthStatus() {
  const [auth, setAuth] = useState<ClaudeAuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAuth = useCallback(async () => {
    try {
      const state = await apiFetch<ClaudeAuthState>('/api/config/claude-auth');
      setAuth(state);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAuth();
  }, [fetchAuth]);

  // Listen for SSE events for auth changes
  useEffect(() => {
    const es = new EventSource(`${BASE_URL}/api/pipeline/stream`);
    const handler = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data);
        if (event.event_type === 'claude_auth_connected' || event.event_type === 'claude_auth_disconnected') {
          fetchAuth();
        }
      } catch { /* ignore parse errors */ }
    };
    es.addEventListener('wal_event', handler);
    return () => { es.close(); };
  }, [fetchAuth]);

  const handleLogin = async () => {
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch('/api/config/claude-auth/login', { method: 'POST' });
    } catch (err: any) {
      setError(err.message || 'Failed to trigger Claude login');
    } finally {
      setActionLoading(false);
    }
  };

  const handleLogout = async () => {
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch('/api/config/claude-auth/logout', { method: 'POST' });
      setAuth(prev => prev ? { ...prev, connected: false, email: undefined, tier: undefined, expiresAt: undefined } : prev);
    } catch (err: any) {
      setError(err.message || 'Failed to disconnect Claude');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted text-xs">
        <Loader2 size={12} className="animate-spin" /> Checking Claude auth...
      </div>
    );
  }

  if (!auth) return null;

  // Token expiry warning: within 24h
  const expiringWarning = auth.expiresAt && (auth.expiresAt - Date.now()) < 24 * 60 * 60 * 1000 && auth.expiresAt > Date.now();

  return (
    <div className={`border rounded-lg p-4 transition-colors ${auth.connected
        ? expiringWarning
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-green-500/30 bg-green-500/5'
        : 'border-amber-500/30 bg-amber-500/5'
      }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${auth.connected
              ? expiringWarning ? 'bg-amber-400' : 'bg-green-400'
              : 'bg-amber-400'
            }`} />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text)]">Claude Account</span>
              {auth.cliVersion && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent/15 text-accent border border-accent/20">
                  CLI v{auth.cliVersion}
                </span>
              )}
              {!auth.cliInstalled && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-red-500/15 text-red-400 border border-red-500/20">
                  CLI not found
                </span>
              )}
            </div>
            {auth.connected ? (
              <p className="text-xs text-green-400 mt-0.5 flex items-center gap-1">
                <CheckCircle2 size={12} />
                {auth.email
                  ? <>Connected as <span className="font-medium">{auth.email}</span>{auth.tier ? ` (Claude ${auth.tier})` : ''}</>
                  : 'Connected via Claude CLI'
                }
              </p>
            ) : (
              <p className="text-xs text-amber-400 mt-0.5 flex items-center gap-1">
                <AlertTriangle size={12} />
                Not connected — sign in to enable pipeline execution
              </p>
            )}
            {expiringWarning && (
              <p className="text-[11px] text-amber-400 mt-1 flex items-center gap-1">
                <AlertTriangle size={11} />
                Session expiring soon — reconnect to avoid pipeline failures
              </p>
            )}
          </div>
        </div>
        <div>
          {auth.connected ? (
            <button
              onClick={handleLogout}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-500/30 rounded text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              {actionLoading ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
              Disconnect
            </button>
          ) : (
            <button
              onClick={handleLogin}
              disabled={actionLoading || !auth.cliInstalled}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {actionLoading ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
              Connect Claude Account
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded text-xs bg-red-500/10 border border-red-500/20 text-red-400">
          <XCircle size={14} />
          {error}
        </div>
      )}
    </div>
  );
}

// ─── Codex Auth Status (OC-026) ─────────────────────────────────────────────

interface CodexAuthState {
  connected: boolean;
  username?: string;
  plan?: string;
  cliInstalled: boolean;
  cliVersion?: string;
}

function CodexAuthStatus() {
  const [auth, setAuth] = useState<CodexAuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAuth = useCallback(async () => {
    try {
      const state = await apiFetch<CodexAuthState>('/api/config/codex-auth');
      setAuth(state);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAuth();
  }, [fetchAuth]);

  // Listen for SSE events for auth changes
  useEffect(() => {
    const es = new EventSource(`${BASE_URL}/api/pipeline/stream`);
    const handler = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data);
        if (event.event_type === 'codex_auth_connected' || event.event_type === 'codex_auth_disconnected') {
          fetchAuth();
        }
      } catch { /* ignore parse errors */ }
    };
    es.addEventListener('wal_event', handler);
    return () => { es.close(); };
  }, [fetchAuth]);

  const handleLogin = async () => {
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch('/api/config/codex-auth/login', { method: 'POST' });
    } catch (err: any) {
      setError(err.message || 'Failed to trigger Codex login');
    } finally {
      setActionLoading(false);
    }
  };

  const handleLogout = async () => {
    setActionLoading(true);
    setError(null);
    try {
      await apiFetch('/api/config/codex-auth/logout', { method: 'POST' });
      setAuth(prev => prev ? { ...prev, connected: false, username: undefined, plan: undefined } : prev);
    } catch (err: any) {
      setError(err.message || 'Failed to disconnect ChatGPT');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted text-xs">
        <Loader2 size={12} className="animate-spin" /> Checking Codex auth...
      </div>
    );
  }

  if (!auth) return null;

  // Capitalize plan name for display
  const planDisplay = auth.plan ? auth.plan.charAt(0).toUpperCase() + auth.plan.slice(1) : null;

  return (
    <div className={`border rounded-lg p-4 transition-colors ${auth.connected
        ? 'border-green-500/30 bg-green-500/5'
        : 'border-amber-500/30 bg-amber-500/5'
      }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${auth.connected ? 'bg-green-400' : 'bg-amber-400'
            }`} />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text)]">ChatGPT Account</span>
              {auth.cliVersion && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-accent/15 text-accent border border-accent/20">
                  CLI v{auth.cliVersion}
                </span>
              )}
              {!auth.cliInstalled && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-red-500/15 text-red-400 border border-red-500/20">
                  CLI not found
                </span>
              )}
            </div>
            {auth.connected ? (
              <p className="text-xs text-green-400 mt-0.5 flex items-center gap-1">
                <CheckCircle2 size={12} />
                {auth.username
                  ? <>Connected as <span className="font-medium">{auth.username}</span>{planDisplay ? ` (ChatGPT ${planDisplay})` : ''}</>
                  : 'Connected via Codex CLI'
                }
              </p>
            ) : (
              <p className="text-xs text-amber-400 mt-0.5 flex items-center gap-1">
                <AlertTriangle size={12} />
                Not connected — sign in to enable Codex pipeline execution
              </p>
            )}
          </div>
        </div>
        <div>
          {auth.connected ? (
            <button
              onClick={handleLogout}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-500/30 rounded text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              {actionLoading ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
              Disconnect
            </button>
          ) : (
            <button
              onClick={handleLogin}
              disabled={actionLoading || !auth.cliInstalled}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {actionLoading ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
              Connect ChatGPT Account
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded text-xs bg-red-500/10 border border-red-500/20 text-red-400">
          <XCircle size={14} />
          {error}
        </div>
      )}
    </div>
  );
}

function ExecutionEngineSection() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [models, setModels] = useState<OpenCodeModelEntry[]>([]);
  const [grouped, setGrouped] = useState<Record<string, OpenCodeModelEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [copilotStatus, setCopilotStatus] = useState<CopilotStatus>({ connected: false, githubUsername: null, connectedAt: null });
  const [copilotLoading, setCopilotLoading] = useState(false);
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  // OpenRouter state (OC-027)
  const [openRouterConnected, setOpenRouterConnected] = useState(false);
  const [openRouterModelCount, setOpenRouterModelCount] = useState<number | null>(null);
  const [openRouterFreeCount, setOpenRouterFreeCount] = useState<number | null>(null);
  const [openRouterTesting, setOpenRouterTesting] = useState(false);
  const [openRouterTestError, setOpenRouterTestError] = useState<string | null>(null);
  const [openRouterKey, setOpenRouterKey] = useState('');
  const [openRouterSaving, setOpenRouterSaving] = useState(false);
  const [openRouterModels, setOpenRouterModels] = useState<Array<{
    id: string; name: string; provider: string; contextWindow: number; free: boolean;
  }>>([]);
  const [openRouterGrouped, setOpenRouterGrouped] = useState<Record<string, Array<{
    id: string; name: string; provider: string; contextWindow: number; free: boolean;
  }>>>({});

  // Local form state
  const [selectedType, setSelectedType] = useState<'claude' | 'opencode' | 'codex'>('claude');
  const [selectedModel, setSelectedModel] = useState<string>('');

  const fetchCopilotStatus = useCallback(async () => {
    try {
      const status = await apiFetch<CopilotStatus>('/api/copilot/status');
      setCopilotStatus(status);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    Promise.all([
      apiFetch<AgentConfig>('/api/config'),
      apiFetch<{ models: OpenCodeModelEntry[]; grouped: Record<string, OpenCodeModelEntry[]>; ollamaAvailable?: boolean }>('/api/config/opencode-models'),
      apiFetch<OllamaStatus>('/api/config/ollama'),
    ]).then(([cfg, modelData, ollama]) => {
      setConfig(cfg);
      setSelectedType(cfg.agentType === 'opencode' ? 'opencode' : cfg.agentType === 'codex' ? 'codex' : 'claude');
      setSelectedModel(cfg.agentModel ?? '');
      setModels(modelData.models);
      setGrouped(modelData.grouped);
      setOllamaStatus(ollama);
      setCopilotStatus({ connected: cfg.copilotConnected, githubUsername: cfg.copilotUsername, connectedAt: null });
    }).catch(() => { })
      .finally(() => setLoading(false));
    fetchCopilotStatus();
  }, [fetchCopilotStatus]);

  // Check URL params for copilot=connected (OAuth callback redirect)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('copilot') === 'connected') {
      fetchCopilotStatus();
      // Clean up URL
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [fetchCopilotStatus]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await apiFetch<{ agentType: string; agentModel: string | null }>('/api/config/agent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: selectedType,
          agentModel: selectedType === 'opencode' ? selectedModel : null,
        }),
      });
      setConfig(prev => prev ? {
        ...prev,
        agentType: result.agentType as AgentConfig['agentType'],
        agentModel: result.agentModel,
      } : prev);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleCopilotConnect = async () => {
    setCopilotLoading(true);
    try {
      const { url } = await apiFetch<{ url: string }>('/api/copilot/connect');
      window.location.href = url;
    } catch (err: any) {
      setError(err.message || 'Failed to start GitHub Copilot sign-in');
      setCopilotLoading(false);
    }
  };

  const handleCopilotDisconnect = async () => {
    setCopilotLoading(true);
    try {
      await apiFetch('/api/copilot/disconnect', { method: 'DELETE' });
      setCopilotStatus({ connected: false, githubUsername: null, connectedAt: null });
      // If currently using copilot model, clear the selection
      if (selectedModel === 'github/copilot') {
        setSelectedModel('');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to disconnect GitHub Copilot');
    } finally {
      setCopilotLoading(false);
    }
  };

  // ─── OpenRouter handlers (OC-027) ─────────────────────────────────────────

  const fetchOpenRouterModels = useCallback(async () => {
    try {
      const data = await apiFetch<{
        models: Array<{ id: string; name: string; provider: string; contextWindow: number; free: boolean }>;
        modelCount: number;
        grouped: Record<string, Array<{ id: string; name: string; provider: string; contextWindow: number; free: boolean }>>;
      }>('/api/config/openrouter-models');
      setOpenRouterModels(data.models);
      setOpenRouterGrouped(data.grouped);
      setOpenRouterModelCount(data.modelCount);
      setOpenRouterConnected(true);
      setOpenRouterTestError(null);
    } catch {
      // Key not configured or API error — not connected
      setOpenRouterConnected(false);
    }
  }, []);

  useEffect(() => {
    if (selectedType === 'opencode') {
      fetchOpenRouterModels();
    }
  }, [selectedType, fetchOpenRouterModels]);

  const handleOpenRouterTest = async (keyToTest?: string) => {
    setOpenRouterTesting(true);
    setOpenRouterTestError(null);
    try {
      const result = await apiFetch<{ ok: boolean; latencyMs?: number; modelCount?: number; freeCount?: number; error?: string }>(
        '/api/config/openrouter-test',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: keyToTest }),
        },
      );
      if (result.ok) {
        setOpenRouterConnected(true);
        setOpenRouterModelCount(result.modelCount ?? null);
        setOpenRouterFreeCount(result.freeCount ?? null);
        setOpenRouterTestError(null);
        // Refresh model list
        fetchOpenRouterModels();
      } else {
        setOpenRouterConnected(false);
        setOpenRouterTestError(result.error ?? 'Connection failed');
      }
    } catch (err: any) {
      setOpenRouterConnected(false);
      setOpenRouterTestError(err.message || 'Connection failed');
    } finally {
      setOpenRouterTesting(false);
    }
  };

  const handleOpenRouterSaveKey = async () => {
    if (!openRouterKey.trim()) return;
    setOpenRouterSaving(true);
    setOpenRouterTestError(null);
    try {
      await apiFetch('/api/vault/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openrouter', key: openRouterKey.trim(), label: 'OpenRouter' }),
      });
      // Test the saved key
      await handleOpenRouterTest();
      setOpenRouterKey('');
    } catch (err: any) {
      setOpenRouterTestError(err.message || 'Failed to save key');
    } finally {
      setOpenRouterSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading execution engine config...</div>;
  }

  const hasChanges = config && (
    selectedType !== config.agentType ||
    (selectedType === 'opencode' && selectedModel !== (config.agentModel ?? ''))
  );

  const PROVIDER_ORDER = ['OpenAI', 'Google', 'Anthropic', 'OpenRouter', 'GitHub Copilot', 'Local'];

  return (
    <div className="space-y-5">
      {showSetupGuide && <OpenCodeSetupGuide onClose={() => setShowSetupGuide(false)} />}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
            <Cpu size={16} className="text-accent" />
            Execution Engine
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Choose how Rorca executes pipeline stories
            <button
              onClick={() => setShowSetupGuide(true)}
              className="inline-flex items-center gap-1 ml-2 text-accent hover:text-accent/80 transition-colors"
            >
              <BookOpen size={11} />
              <span className="underline underline-offset-2">Setup Guide</span>
            </button>
          </p>
        </div>
        {/* Status badge */}
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full ${config?.agentType === 'codex'
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : config?.agentType === 'opencode'
                ? config?.agentModel === 'github/copilot'
                  ? 'bg-[#24292f]/20 text-[#8b949e] border border-[#30363d]'
                  : config?.agentModel?.startsWith('ollama/')
                    ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                    : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                : 'bg-accent/10 text-accent border border-accent/20'
            }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${config?.agentType === 'codex'
                ? 'bg-emerald-400'
                : config?.agentType === 'opencode'
                  ? config?.agentModel === 'github/copilot' ? 'bg-[#8b949e]'
                    : config?.agentModel?.startsWith('ollama/') ? 'bg-green-400' : 'bg-purple-400'
                  : 'bg-accent'
              }`} />
            {config?.agentType === 'codex'
              ? 'Codex CLI'
              : config?.agentType === 'opencode'
                ? config?.agentModel === 'github/copilot' ? 'GitHub Copilot'
                  : config?.agentModel?.startsWith('ollama/') ? 'Local (Ollama)' : 'OpenCode'
                : 'Claude'}
            {config?.agentType === 'opencode' && config?.agentModel && config?.agentModel !== 'github/copilot' && (
              <span className="text-muted ml-0.5">
                {models.find(m => m.id === config.agentModel)?.name ?? config.agentModel}
              </span>
            )}
          </span>
          {config?.agentType === 'codex' && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-emerald-500/15 text-emerald-400">
              Subscription
            </span>
          )}
          {config?.agentType === 'opencode' && config?.agentModel === 'github/copilot' && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-500/15 text-purple-400">
              Subscription
            </span>
          )}
          {config?.agentType === 'opencode' && config?.agentModel?.startsWith('ollama/') && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-green-500/15 text-green-400">
              Free
            </span>
          )}
        </div>
      </div>

      {/* Agent type toggle */}
      <div className="flex gap-3">
        <button
          onClick={() => setSelectedType('claude')}
          className={`flex-1 border rounded-lg p-4 text-left transition-all ${selectedType === 'claude'
              ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
              : 'border-border bg-bg hover:border-accent/30'
            }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${selectedType === 'claude' ? 'border-accent' : 'border-border'
              }`}>
              {selectedType === 'claude' && <div className="w-1.5 h-1.5 rounded-full bg-accent" />}
            </div>
            <span className="text-sm font-medium text-[var(--text)]">Claude Subscription</span>
          </div>
          <p className="text-[11px] text-muted ml-5">
            Uses <code className="text-xs bg-panel px-1 rounded">claude --print</code> via your Pro/Max subscription. No API key needed.
          </p>
        </button>

        <button
          onClick={() => setSelectedType('opencode')}
          className={`flex-1 border rounded-lg p-4 text-left transition-all ${selectedType === 'opencode'
              ? 'border-purple-500/60 bg-purple-500/5 ring-1 ring-purple-500/30'
              : 'border-border bg-bg hover:border-purple-500/30'
            }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${selectedType === 'opencode' ? 'border-purple-500' : 'border-border'
              }`}>
              {selectedType === 'opencode' && <div className="w-1.5 h-1.5 rounded-full bg-purple-500" />}
            </div>
            <span className="text-sm font-medium text-[var(--text)]">OpenCode (API Key)</span>
          </div>
          <p className="text-[11px] text-muted ml-5">
            75+ models via API key: OpenAI, Google, Anthropic, OpenRouter, local Ollama.
          </p>
        </button>

        <button
          onClick={() => setSelectedType('codex')}
          className={`flex-1 border rounded-lg p-4 text-left transition-all ${selectedType === 'codex'
              ? 'border-emerald-500/60 bg-emerald-500/5 ring-1 ring-emerald-500/30'
              : 'border-border bg-bg hover:border-emerald-500/30'
            }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${selectedType === 'codex' ? 'border-emerald-500' : 'border-border'
              }`}>
              {selectedType === 'codex' && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
            </div>
            <span className="text-sm font-medium text-[var(--text)]">Codex CLI (ChatGPT subscription)</span>
          </div>
          <p className="text-[11px] text-muted ml-5">
            Uses <code className="text-xs bg-panel px-1 rounded">codex --approval-mode auto-edit</code> via your ChatGPT Plus/Pro subscription.
          </p>
        </button>
      </div>

      {/* Claude auth status (OC-025) */}
      {selectedType === 'claude' && <ClaudeAuthStatus />}

      {/* Codex auth status (OC-026) */}
      {selectedType === 'codex' && <CodexAuthStatus />}

      {/* OpenCode installation status */}
      {selectedType === 'opencode' && config && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded text-xs ${config.opencodeInstalled
            ? 'bg-green-500/10 border border-green-500/20 text-green-400'
            : 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
          }`}>
          {config.opencodeInstalled ? (
            <>
              <CheckCircle2 size={14} />
              OpenCode installed{config.opencodeVersion ? ` (v${config.opencodeVersion})` : ''}
            </>
          ) : (
            <>
              <AlertTriangle size={14} />
              OpenCode not found. Install: <code className="bg-panel px-1 rounded">npm i -g opencode</code>
            </>
          )}
        </div>
      )}

      {/* Ollama status (shown when OpenCode selected) */}
      {selectedType === 'opencode' && ollamaStatus && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded text-xs ${ollamaStatus.available
            ? 'bg-green-500/10 border border-green-500/20 text-green-400'
            : 'bg-zinc-500/10 border border-zinc-500/20 text-zinc-400'
          }`}>
          {ollamaStatus.available ? (
            <>
              <CheckCircle2 size={14} />
              Ollama running — {ollamaStatus.models.length} model{ollamaStatus.models.length !== 1 ? 's' : ''} available
              <span className="ml-auto px-1.5 py-0.5 text-[10px] font-semibold rounded bg-green-500/15 text-green-400">
                Local — Free
              </span>
            </>
          ) : (
            <>
              <AlertTriangle size={14} />
              Ollama not detected. Start with: <code className="bg-panel px-1 rounded">ollama serve</code>
            </>
          )}
        </div>
      )}

      {/* Model selector (only when OpenCode selected) */}
      {selectedType === 'opencode' && (
        <div>
          <label className="block text-xs text-muted mb-2">Model</label>
          <div className="relative">
            <select
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
              className="w-full px-3 py-2.5 text-sm bg-bg border border-border rounded-lg focus:border-purple-500/60 outline-none appearance-none pr-8"
            >
              <option value="">Select a model...</option>
              {PROVIDER_ORDER.filter(p => grouped[p]).map(provider => (
                <optgroup key={provider} label={provider === 'Local' ? 'Local (Ollama) — Free' : provider === 'GitHub Copilot' ? 'GitHub Copilot — Subscription' : provider}>
                  {grouped[provider].map(m => (
                    <option key={m.id} value={m.id}>
                      {m.name} — {m.contextWindow >= 1000000
                        ? `${(m.contextWindow / 1000000).toFixed(m.contextWindow % 1000000 === 0 ? 0 : 1)}M`
                        : `${(m.contextWindow / 1000).toFixed(0)}K`} ctx
                    </option>
                  ))}
                </optgroup>
              ))}
              {/* OpenRouter models grouped by provider family (OC-027) */}
              {openRouterConnected && Object.entries(openRouterGrouped)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([family, familyModels]) => (
                  <optgroup key={`or-${family}`} label={`OpenRouter — ${family}`}>
                    {familyModels.map(m => (
                      <option key={`or-${m.id}`} value={`openrouter/${m.id}`}>
                        {m.name}{m.free && m.contextWindow >= 8192 ? ' [Free]' : ''} — {m.contextWindow >= 1000000
                          ? `${(m.contextWindow / 1000000).toFixed(m.contextWindow % 1000000 === 0 ? 0 : 1)}M`
                          : `${(m.contextWindow / 1000).toFixed(0)}K`} ctx
                      </option>
                    ))}
                  </optgroup>
                ))}
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          </div>
          {!selectedModel && (
            <p className="text-[11px] text-amber-400 mt-1.5">Select a model to enable OpenCode execution</p>
          )}
          {/* Free tier badge for selected Ollama model */}
          {selectedModel.startsWith('ollama/') && (
            <div className="flex items-center gap-2 mt-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-full bg-green-500/15 text-green-400 border border-green-500/20">
                Local — Free
              </span>
              <span className="text-[11px] text-muted">No API key required. Runs entirely on your machine.</span>
            </div>
          )}
        </div>
      )}

      {/* GitHub Copilot connection status (shown when OpenCode selected) */}
      {selectedType === 'opencode' && (
        <div className={`border rounded-lg p-4 transition-colors ${copilotStatus.connected
            ? 'border-green-500/30 bg-green-500/5'
            : 'border-border bg-bg'
          }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Github size={18} className={copilotStatus.connected ? 'text-green-400' : 'text-muted'} />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text)]">GitHub Copilot</span>
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-500/15 text-purple-400 border border-purple-500/20">
                    Subscription
                  </span>
                </div>
                {copilotStatus.connected ? (
                  <p className="text-xs text-green-400 mt-0.5 flex items-center gap-1">
                    <CheckCircle2 size={12} />
                    Connected as <span className="font-medium">{copilotStatus.githubUsername}</span>
                  </p>
                ) : (
                  <p className="text-xs text-muted mt-0.5">
                    Sign in with GitHub to use your Copilot subscription for model access
                  </p>
                )}
              </div>
            </div>
            <div>
              {copilotStatus.connected ? (
                <button
                  onClick={handleCopilotDisconnect}
                  disabled={copilotLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red-500/30 rounded text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                >
                  {copilotLoading ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={handleCopilotConnect}
                  disabled={copilotLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#24292f] text-white rounded hover:bg-[#2f363d] transition-colors disabled:opacity-50"
                >
                  {copilotLoading ? <Loader2 size={12} className="animate-spin" /> : <Github size={12} />}
                  Sign in with GitHub
                </button>
              )}
            </div>
          </div>
          {/* Subscription badge when connected and github/copilot selected */}
          {copilotStatus.connected && selectedModel === 'github/copilot' && (
            <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded bg-purple-500/10 border border-purple-500/20">
              <span className="text-xs text-purple-400">
                Using your GitHub Copilot subscription — no per-token API billing
              </span>
            </div>
          )}
          {/* Warning when copilot model selected but not connected */}
          {!copilotStatus.connected && selectedModel === 'github/copilot' && (
            <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
              <AlertTriangle size={14} />
              Sign in with GitHub above to use Copilot
            </div>
          )}
        </div>
      )}

      {/* OpenRouter provider card (OC-027) */}
      {selectedType === 'opencode' && (
        <div className={`border rounded-lg p-4 transition-colors ${openRouterConnected
            ? 'border-orange-500/30 bg-orange-500/5'
            : 'border-border bg-bg'
          }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Globe size={18} className={openRouterConnected ? 'text-orange-400' : 'text-muted'} />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text)]">OpenRouter</span>
                  {openRouterConnected && openRouterModelCount !== null && (
                    <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-orange-500/15 text-orange-400 border border-orange-500/20">
                      {openRouterModelCount} models available
                    </span>
                  )}
                </div>
                {openRouterConnected ? (
                  <p className="text-xs text-green-400 mt-0.5 flex items-center gap-1">
                    <CheckCircle2 size={12} />
                    Connected
                    {openRouterFreeCount !== null && openRouterFreeCount > 0 && (
                      <span className="text-muted ml-1">({openRouterFreeCount} free models)</span>
                    )}
                  </p>
                ) : (
                  <p className="text-xs text-muted mt-0.5">
                    Access 200+ models through a single API key. Supports OpenAI, Anthropic, Google, Meta, Mistral, and more.
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {openRouterConnected && (
                <button
                  onClick={() => handleOpenRouterTest()}
                  disabled={openRouterTesting}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded hover:border-orange-500/40 text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50"
                >
                  {openRouterTesting ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
                  Test Connection
                </button>
              )}
              <a
                href="https://openrouter.ai/models"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-3 py-1.5 text-xs text-muted hover:text-[var(--text)] border border-border rounded hover:border-orange-500/40 transition-colors"
              >
                Browse all models
              </a>
            </div>
          </div>

          {/* Test result */}
          {openRouterTestError && (
            <div className="mt-3 px-3 py-2 rounded text-xs flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-400">
              <XCircle size={14} />
              {openRouterTestError}
            </div>
          )}

          {/* API key input (shown when not connected) */}
          {!openRouterConnected && (
            <div className="mt-3 border border-border rounded p-3 space-y-3 bg-panel">
              <div>
                <label className="block text-xs text-muted mb-1">OpenRouter API Key</label>
                <input
                  type="password"
                  value={openRouterKey}
                  onChange={e => setOpenRouterKey(e.target.value)}
                  placeholder="sk-or-..."
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-orange-500/60 outline-none font-mono"
                  autoFocus
                />
                <p className="text-[10px] text-muted mt-1">
                  Get your key at{' '}
                  <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:underline">
                    openrouter.ai/keys
                  </a>
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleOpenRouterTest(openRouterKey.trim())}
                  disabled={openRouterTesting || !openRouterKey.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded hover:border-orange-500/40 text-muted hover:text-[var(--text)] transition-colors disabled:opacity-50"
                >
                  {openRouterTesting ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
                  Test Connection
                </button>
                <button
                  onClick={handleOpenRouterSaveKey}
                  disabled={openRouterSaving || !openRouterKey.trim()}
                  className="flex items-center gap-2 px-4 py-1.5 text-xs bg-orange-500 text-white rounded hover:bg-orange-500/90 disabled:opacity-50 transition-colors"
                >
                  {openRouterSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  Save Key
                </button>
              </div>
            </div>
          )}

          {/* OpenRouter model selector (shown when connected and an OpenRouter model is selected or browsing) */}
          {openRouterConnected && openRouterModels.length > 0 && selectedModel.startsWith('openrouter/') && (
            <div className="mt-3">
              <label className="block text-xs text-muted mb-1.5">OpenRouter Model</label>
              <div className="relative">
                <select
                  value={selectedModel}
                  onChange={e => setSelectedModel(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-orange-500/60 outline-none appearance-none pr-8"
                >
                  {Object.entries(openRouterGrouped)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([family, familyModels]) => (
                      <optgroup key={family} label={family}>
                        {familyModels.map(m => (
                          <option key={m.id} value={`openrouter/${m.id}`}>
                            {m.name}{m.free ? ' [Free]' : ''} — {m.contextWindow >= 1000000
                              ? `${(m.contextWindow / 1000000).toFixed(m.contextWindow % 1000000 === 0 ? 0 : 1)}M`
                              : `${(m.contextWindow / 1000).toFixed(0)}K`} ctx
                          </option>
                        ))}
                      </optgroup>
                    ))}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded text-xs bg-red-500/10 border border-red-500/20 text-red-400">
          <XCircle size={14} />
          {error}
        </div>
      )}

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving || !hasChanges || (selectedType === 'opencode' && !selectedModel) || (selectedType === 'codex' && config?.codexInstalled === false)}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? 'Saved' : 'Save Engine Configuration'}
      </button>
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
            <div key={p.id} className={`border rounded p-4 transition-colors ${isDefault ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg'
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
      className={`border rounded p-3 transition-colors cursor-pointer ${isSelected
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
              className={`px-4 py-2 text-sm rounded border transition-colors capitalize ${mode === m
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
                className={`border rounded-lg p-4 flex flex-col ${isCurrent
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
                      aria-label="Download invoice PDF"
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
                      aria-label="View invoice"
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
              aria-label={showPasswords ? 'Hide passwords' : 'Show passwords'}
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
      .catch(() => { })
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
        { keys: [`${mod}`, '\\'], description: 'Toggle navigation drawer' },
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

// ─── Model Routing Section (OC-021) ──────────────────────────────────────────

type RouterMode = 'auto' | 'fixed' | 'manual';
type TaskType = 'echolocation' | 'planning' | 'coding' | 'lintFix' | 'testing' | 'documentation';

interface OrchestrationState {
  router: RouterMode;
  thresholds: { haiku: [number, number]; sonnet: [number, number]; opus: [number, number] };
  taskCascades: Record<TaskType, string>;
  escalation: { enabled: boolean; maxRetriesOnTier: number; chain: string[]; escalateTo: Record<string, string | null> };
  tokenBudgetPerStory: number;
}

const TASK_TYPE_LABELS: Record<TaskType, { label: string; description: string }> = {
  echolocation: { label: 'Echolocation', description: 'Codebase exploration & context gathering' },
  planning: { label: 'Planning', description: 'Implementation strategy & architecture decisions' },
  coding: { label: 'Coding', description: 'Code implementation' },
  lintFix: { label: 'Lint Fix', description: 'Lint & typecheck error resolution' },
  testing: { label: 'Testing', description: 'Test writing & validation' },
  documentation: { label: 'Documentation', description: 'Documentation generation' },
};

const ROUTER_MODE_INFO: Record<RouterMode, { label: string; description: string }> = {
  auto: { label: 'Auto (Complexity Scorer)', description: 'Automatically assigns model tier based on story complexity signals' },
  fixed: { label: 'Fixed', description: 'Uses the spec model for all stories — no tier assignment' },
  manual: { label: 'Manual', description: 'Per-story modelTier overrides in spec JSON — falls back to auto if unset' },
};

function ModelRoutingSection() {
  const { workspaceId } = useWorkspace();
  const [config, setConfig] = useState<OrchestrationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const url = workspaceId
      ? `/api/config/orchestration?workspaceId=${workspaceId}`
      : '/api/config/orchestration';
    apiFetch<OrchestrationState>(url)
      .then(data => {
        setConfig(data);
        setDirty(false);
      })
      .catch(() => { })
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const update = <K extends keyof OrchestrationState>(key: K, value: OrchestrationState[K]) => {
    setConfig(prev => prev ? { ...prev, [key]: value } : prev);
    setDirty(true);
  };

  const handleSave = async () => {
    if (!config || !workspaceId) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // Convert threshold ranges to the format backend expects
      const payload = {
        router: config.router,
        thresholds: {
          haiku: config.thresholds.haiku,
          sonnet: config.thresholds.sonnet,
          opus: config.thresholds.opus,
        },
        taskCascades: config.taskCascades,
        escalation: config.escalation,
        tokenBudgetPerStory: config.tokenBudgetPerStory,
      };
      const result = await apiFetch<OrchestrationState>('/api/config/orchestration', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, orchestration: payload }),
      });
      setConfig(result);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading model routing config...</div>;
  }

  if (!config) return null;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
          <SlidersHorizontal size={16} className="text-accent" />
          Model Routing
        </h2>
        <p className="text-xs text-muted mt-0.5">
          Configure how stories are assigned to model tiers and which models handle each task type.
        </p>
      </div>

      {/* Router mode */}
      <div>
        <label className="block text-xs text-muted mb-2">Router Mode</label>
        <div className="grid grid-cols-3 gap-2">
          {(['auto', 'fixed', 'manual'] as RouterMode[]).map(mode => {
            const info = ROUTER_MODE_INFO[mode];
            return (
              <button
                key={mode}
                onClick={() => update('router', mode)}
                className={`border rounded-lg p-3 text-left transition-all ${config.router === mode
                    ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
                    : 'border-border bg-bg hover:border-accent/30'
                  }`}
              >
                <span className="text-xs font-medium text-[var(--text)]">{info.label}</span>
                <p className="text-[10px] text-muted mt-0.5 leading-tight">{info.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Three-tier threshold slider (only shown in auto mode) */}
      {config.router === 'auto' && (
        <div>
          <label className="block text-xs text-muted mb-2">Complexity Thresholds</label>
          <ThresholdSlider
            haikuMax={config.thresholds.haiku[1]}
            sonnetMax={config.thresholds.sonnet[1]}
            onChange={(haikuMax, sonnetMax) => {
              update('thresholds', {
                haiku: [0, haikuMax],
                sonnet: [haikuMax + 1, sonnetMax],
                opus: [sonnetMax + 1, 100],
              });
            }}
          />
        </div>
      )}

      {/* Task cascades */}
      <div>
        <label className="block text-xs text-muted mb-2">Task Type Model Assignments</label>
        <div className="border border-border rounded overflow-hidden">
          {(Object.entries(TASK_TYPE_LABELS) as [TaskType, { label: string; description: string }][]).map(([taskType, info]) => (
            <div key={taskType} className="flex items-center justify-between px-4 py-2.5 border-b border-border last:border-b-0">
              <div className="min-w-0">
                <span className="text-sm text-[var(--text)]">{info.label}</span>
                <p className="text-[10px] text-muted">{info.description}</p>
              </div>
              <input
                type="text"
                value={config.taskCascades[taskType] ?? ''}
                onChange={e => {
                  const newCascades = { ...config.taskCascades, [taskType]: e.target.value };
                  update('taskCascades', newCascades);
                }}
                className="w-64 px-2 py-1.5 text-xs bg-bg border border-border rounded focus:border-accent outline-none font-mono"
                placeholder="model-id"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Escalation */}
      <div>
        <label className="block text-xs text-muted mb-2">Escalation</label>
        <div className="border border-border rounded p-4 bg-bg space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-[var(--text)]">Auto-escalate on failure</span>
              <p className="text-[10px] text-muted">Upgrade to a higher tier when a story fails repeatedly</p>
            </div>
            <ToggleSwitch
              checked={config.escalation.enabled}
              onChange={() => update('escalation', { ...config.escalation, enabled: !config.escalation.enabled })}
            />
          </div>
          {config.escalation.enabled && (
            <div className="flex items-center gap-4 pt-1">
              <div className="flex-1">
                <label className="block text-[10px] text-muted mb-1">Max retries per tier</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={config.escalation.maxRetriesOnTier}
                  onChange={e => update('escalation', { ...config.escalation, maxRetriesOnTier: parseInt(e.target.value) || 0 })}
                  className="w-full px-2 py-1.5 text-xs bg-panel border border-border rounded focus:border-accent outline-none"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[10px] text-muted mb-1">Chain</label>
                <div className="flex items-center gap-1 text-xs text-muted">
                  <span className="px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">Haiku</span>
                  <span>&rarr;</span>
                  <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">Sonnet</span>
                  <span>&rarr;</span>
                  <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">Opus</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Token budget */}
      <div>
        <label className="block text-xs text-muted mb-2">Token Budget Per Story</label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1000}
            step={5000}
            value={config.tokenBudgetPerStory}
            onChange={e => update('tokenBudgetPerStory', parseInt(e.target.value) || 50000)}
            className="w-40 px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
          />
          <span className="text-xs text-muted">input tokens before warning (default: 50,000)</span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded text-xs bg-red-500/10 border border-red-500/20 text-red-400">
          <XCircle size={14} />
          {error}
        </div>
      )}

      {/* No workspace warning */}
      {!workspaceId && (
        <div className="flex items-center gap-2 px-3 py-2 rounded text-xs bg-amber-500/10 border border-amber-500/20 text-amber-400">
          <AlertTriangle size={14} />
          Select a workspace to save routing configuration to .rorca/config.json
        </div>
      )}

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saving || !dirty || !workspaceId}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
        {saved ? 'Saved' : 'Save Routing Configuration'}
      </button>
    </div>
  );
}

// ─── Three-Tier Threshold Slider ──────────────────────────────────────────────

function ThresholdSlider({
  haikuMax,
  sonnetMax,
  onChange,
}: {
  haikuMax: number;
  sonnetMax: number;
  onChange: (haikuMax: number, sonnetMax: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'haiku' | 'sonnet' | null>(null);

  const getPositionFromEvent = (e: MouseEvent | React.MouseEvent): number => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    return Math.round((x / rect.width) * 100);
  };

  const handleMouseDown = (handle: 'haiku' | 'sonnet') => (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = handle;

    const onMove = (ev: MouseEvent) => {
      const pos = getPositionFromEvent(ev);
      if (dragging.current === 'haiku') {
        const clamped = Math.max(1, Math.min(pos, sonnetMax - 1));
        onChange(clamped, sonnetMax);
      } else if (dragging.current === 'sonnet') {
        const clamped = Math.max(haikuMax + 1, Math.min(pos, 99));
        onChange(haikuMax, clamped);
      }
    };

    const onUp = () => {
      dragging.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div className="space-y-2">
      {/* Slider track */}
      <div
        ref={trackRef}
        className="relative h-8 rounded-lg overflow-hidden cursor-pointer select-none"
        style={{ background: 'var(--bg)' }}
      >
        {/* Haiku region */}
        <div
          className="absolute top-0 bottom-0 bg-green-500/20 border-r-2 border-green-500/60"
          style={{ left: 0, width: `${haikuMax}%` }}
        />
        {/* Sonnet region */}
        <div
          className="absolute top-0 bottom-0 bg-blue-500/20 border-r-2 border-blue-500/60"
          style={{ left: `${haikuMax}%`, width: `${sonnetMax - haikuMax}%` }}
        />
        {/* Opus region */}
        <div
          className="absolute top-0 bottom-0 bg-purple-500/20"
          style={{ left: `${sonnetMax}%`, right: 0 }}
        />

        {/* Haiku handle */}
        <div
          className="absolute top-0 bottom-0 w-3 cursor-ew-resize z-10 group"
          style={{ left: `calc(${haikuMax}% - 6px)` }}
          onMouseDown={handleMouseDown('haiku')}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-6 rounded-sm bg-green-400 border border-green-500 shadow-sm group-hover:bg-green-300 transition-colors" />
        </div>

        {/* Sonnet handle */}
        <div
          className="absolute top-0 bottom-0 w-3 cursor-ew-resize z-10 group"
          style={{ left: `calc(${sonnetMax}% - 6px)` }}
          onMouseDown={handleMouseDown('sonnet')}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-6 rounded-sm bg-blue-400 border border-blue-500 shadow-sm group-hover:bg-blue-300 transition-colors" />
        </div>

        {/* Labels inside regions */}
        <div className="absolute inset-0 flex items-center pointer-events-none text-[10px] font-medium">
          <span className="text-green-400 flex-none text-center" style={{ width: `${haikuMax}%` }}>
            Haiku (0–{haikuMax})
          </span>
          <span className="text-blue-400 flex-none text-center" style={{ width: `${sonnetMax - haikuMax}%` }}>
            Sonnet ({haikuMax + 1}–{sonnetMax})
          </span>
          <span className="text-purple-400 flex-1 text-center">
            Opus ({sonnetMax + 1}–100)
          </span>
        </div>
      </div>

      {/* Numeric inputs for precise adjustment */}
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-400" />
          <span className="text-muted">Haiku max:</span>
          <input
            type="number"
            min={1}
            max={sonnetMax - 1}
            value={haikuMax}
            onChange={e => {
              const v = parseInt(e.target.value) || 1;
              onChange(Math.max(1, Math.min(v, sonnetMax - 1)), sonnetMax);
            }}
            className="w-14 px-1.5 py-0.5 bg-bg border border-border rounded text-center focus:border-accent outline-none"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-blue-400" />
          <span className="text-muted">Sonnet max:</span>
          <input
            type="number"
            min={haikuMax + 1}
            max={99}
            value={sonnetMax}
            onChange={e => {
              const v = parseInt(e.target.value) || (haikuMax + 1);
              onChange(haikuMax, Math.max(haikuMax + 1, Math.min(v, 99)));
            }}
            className="w-14 px-1.5 py-0.5 bg-bg border border-border rounded text-center focus:border-accent outline-none"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-purple-400" />
          <span className="text-muted">Opus: {sonnetMax + 1}–100</span>
        </div>
      </div>
    </div>
  );
}

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
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'left-[18px]' : 'left-0.5'
          }`}
      />
    </button>
  );
}
