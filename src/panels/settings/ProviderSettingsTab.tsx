import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Key, Save, Loader2, Trash2, Plus, Check, AlertTriangle, Zap, Globe, CheckCircle2, XCircle, Github, Cpu, BookOpen, SlidersHorizontal, Search, Database, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { ProBadge } from '../../components/UpgradePrompt';
import { useAuth } from '../../contexts/AuthContext';
import AgentPicker from '../../components/AgentPicker';
import ModelSearchSelect, { type ModelOption } from '../../components/ModelSearchSelect';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useTheme, type ThemeMode } from '../../contexts/ThemeContext';
import { apiFetch } from '../../lib/apiFetch';
import { useWalSSE } from '../../hooks/useWalSSE';
import { useGlobalToast } from '../../contexts/ToastContext';
import OpenCodeSetupGuide from '../../components/OpenCodeSetupGuide';

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

interface DisplaySettings {
  defaultModel: string;
  itemsPerPage: number;
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
}

interface ModelTestResult {
  modelId: string;
  ok: boolean;
  latencyMs?: number;
  response?: string;
  error?: string;
}

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

interface ClaudeAuthState {
  connected: boolean;
  email?: string;
  tier?: string;
  expiresAt?: number;
  cliInstalled: boolean;
  cliVersion?: string;
}

interface CodexAuthState {
  connected: boolean;
  username?: string;
  plan?: string;
  cliInstalled: boolean;
  cliVersion?: string;
}

type RouterMode = 'auto' | 'fixed' | 'manual';
type TaskType = 'echolocation' | 'planning' | 'coding' | 'lintFix' | 'testing' | 'documentation';

interface OrchestrationState {
  router: RouterMode;
  thresholds: { haiku: [number, number]; sonnet: [number, number]; opus: [number, number] };
  taskCascades: Record<TaskType, string>;
  escalation: { enabled: boolean; maxRetriesOnTier: number; chain: string[]; escalateTo: Record<string, string | null> };
  tokenBudgetPerStory: number;
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

// ─── Main Export ──────────────────────────────────────────────────────────────

export function ProviderSettingsTab() {
  return (
    <div className="max-w-2xl space-y-8">
      <DisplaySection />
      <div className="border-t border-border pt-6">
        <ExecutionEngineSection />
      </div>
      <div className="border-t border-border pt-6">
        <SemanticEngineSection />
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

// ─── Claude Auth Status (OC-025) ────────────────────────────────────────────

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

  useWalSSE((event) => {
    if (event.event_type === 'claude_auth_connected' || event.event_type === 'claude_auth_disconnected') {
      fetchAuth();
    }
  });

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

  const expiringWarning = auth.expiresAt && (auth.expiresAt - Date.now()) < 24 * 60 * 60 * 1000 && auth.expiresAt > Date.now();

  return (
    <div className={`border rounded-lg p-4 transition-colors ${auth.connected
        ? expiringWarning
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-green-500/30 bg-green-500/5'
        : 'border-amber-500/30 bg-amber-500/5'
      }`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${auth.connected
              ? expiringWarning ? 'bg-amber-400' : 'bg-green-400'
              : 'bg-amber-400'
            }`} />
          <div>
            <div className="flex items-center gap-2 flex-wrap">
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

  useWalSSE((event) => {
    if (event.event_type === 'codex_auth_connected' || event.event_type === 'codex_auth_disconnected') {
      fetchAuth();
    }
  });

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

  const planDisplay = auth.plan ? auth.plan.charAt(0).toUpperCase() + auth.plan.slice(1) : null;

  return (
    <div className={`border rounded-lg p-4 transition-colors ${auth.connected
        ? 'border-green-500/30 bg-green-500/5'
        : 'border-amber-500/30 bg-amber-500/5'
      }`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${auth.connected ? 'bg-green-400' : 'bg-amber-400'
            }`} />
          <div>
            <div className="flex items-center gap-2 flex-wrap">
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

// ─── Execution Engine Section (OC-009) ───────────────────────────────────────

function ExecutionEngineSection() {
  const toast = useGlobalToast();
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
      toast.show('Execution engine saved', 'success');
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      const msg = err.message || 'Failed to save configuration';
      setError(msg);
      toast.show(`Failed to save: ${msg}`, 'error');
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
      await handleOpenRouterTest();
      setOpenRouterKey('');
    } catch (err: any) {
      setOpenRouterTestError(err.message || 'Failed to save key');
    } finally {
      setOpenRouterSaving(false);
    }
  };

  // Transform backend models into ModelOption format for AgentPicker
  const modelOptions: ModelOption[] = useMemo(() => {
    const staticOptions: ModelOption[] = models.map(m => ({
      id: m.id,
      label: m.name,
      provider: m.provider,
      costPer1kInput: (m as any).costPer1kInput ?? 0,
      costPer1kOutput: (m as any).costPer1kOutput ?? 0,
      contextWindow: m.contextWindow,
      speedTier: (m as any).speedTier,
      costTier: (m as any).costTier,
      recommended: false,
    }));

    const orOptions: ModelOption[] = openRouterModels.map(m => ({
      id: `openrouter/${m.id}`,
      label: m.name,
      provider: `OpenRouter`,
      costPer1kInput: (m as any).pricingPrompt ? (m as any).pricingPrompt * 1000 : 0,
      costPer1kOutput: (m as any).pricingCompletion ? (m as any).pricingCompletion * 1000 : 0,
      contextWindow: m.contextWindow,
      speedTier: 'medium' as const,
      costTier: m.free ? 'free' as const : 'medium' as const,
      recommended: false,
    }));

    const seen = new Set(staticOptions.map(m => m.id));
    return [...staticOptions, ...orOptions.filter(m => !seen.has(m.id))];
  }, [models, openRouterModels]);

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading execution engine config...</div>;
  }

  const hasChanges = config && (
    selectedType !== config.agentType ||
    (selectedType === 'opencode' && selectedModel !== (config.agentModel ?? ''))
  );

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
      </div>

      {/* Agent type + model selection */}
      <AgentPicker
        agentType={selectedType}
        agentModel={selectedModel || null}
        onAgentTypeChange={setSelectedType}
        onModelChange={setSelectedModel}
        models={modelOptions}
        claudeInstalled={config?.opencodeInstalled !== false}
        opencodeInstalled={config?.opencodeInstalled ?? undefined}
        codexInstalled={config?.codexInstalled ?? undefined}
      />

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

      {/* GitHub Copilot connection status (shown when OpenCode selected) */}
      {selectedType === 'opencode' && (
        <div className={`border rounded-lg p-4 transition-colors ${copilotStatus.connected
            ? 'border-green-500/30 bg-green-500/5'
            : 'border-border bg-bg'
          }`}>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3">
              <Github size={18} className={copilotStatus.connected ? 'text-green-400' : 'text-muted'} />
              <div>
                <div className="flex items-center gap-2 flex-wrap">
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
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-200 text-text rounded hover:bg-border transition-colors disabled:opacity-50"
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
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3">
              <Globe size={18} className={openRouterConnected ? 'text-orange-400' : 'text-muted'} />
              <div>
                <div className="flex items-center gap-2 flex-wrap">
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
            <div className="flex items-center gap-2 flex-wrap shrink-0">
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
  const providerHasKey = status && (
    status.source !== 'local' ||
    selectedProvider === 'auto' ||
    selectedProvider === 'local'
  );
  const showKeyWarning = selectedProvider !== 'auto' && selectedProvider !== 'local' && status?.provider === 'local';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
            <Database size={16} className="text-accent" />
            Semantic Engine (Embeddings)
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Vector embeddings power semantic search, memory recall, and knowledge graph features
          </p>
        </div>
      </div>

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
    try {
      await apiFetch(`/api/vault/keys/${id}`, { method: 'DELETE' });
      toast.show('API key removed', 'success');
      fetchData();
    } catch {
      toast.show('Failed to remove API key', 'error');
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

      {/* Exa Search — Pro feature */}
      <ExaSearchSection />
    </div>
  );
}

// ─── Exa Search Provider Section ─────────────────────────────────────────────

function ExaSearchSection() {
  const { user } = useAuth();
  const isFreePlan = !user?.plan || user.plan === 'free';

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

  // Test model state
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);

  // Catalog filter state
  const [searchText, setSearchText] = useState('');
  const [activeProvider, setActiveProvider] = useState<string>('All');

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
  const modelsByProvider = models.reduce<Record<string, DisplayModelOption[]>>((acc, m) => {
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
        <ModelSearchSelect
          models={models}
          value={defaultModel}
          defaultModelId={null}
          onChange={setDefaultModel}
        />
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
            Override the global default for this workspace. Persists to the Project direction layer.
          </p>
          <div className="flex gap-2">
            <div className="flex-1">
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

        {/* Search bar row */}
        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input
              type="text"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              placeholder="Search models..."
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-bg border border-border rounded focus:border-accent outline-none placeholder:text-muted"
            />
          </div>
          <span className="text-xs text-muted whitespace-nowrap">
            {(() => {
              const q = searchText.toLowerCase();
              return models.filter(m =>
                (activeProvider === 'All' || m.provider === activeProvider) &&
                (!q || m.label.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
              ).length;
            })()} models
          </span>
        </div>

        {/* Provider filter chips */}
        {(() => {
          const providerCounts = models.reduce<Record<string, number>>((acc, m) => {
            acc[m.provider] = (acc[m.provider] ?? 0) + 1;
            return acc;
          }, {});
          const providers = Object.entries(providerCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([p]) => p);
          return (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {(['All', ...providers]).map(p => (
                <button
                  key={p}
                  onClick={() => setActiveProvider(p)}
                  className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                    activeProvider === p
                      ? 'bg-accent/10 border-accent text-accent'
                      : 'border-border text-muted hover:text-[var(--text)]'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          );
        })()}

        {/* Filtered model cards */}
        <div className="space-y-4">
          {(() => {
            const q = searchText.toLowerCase();
            const filtered = models.filter(m =>
              (activeProvider === 'All' || m.provider === activeProvider) &&
              (!q || m.label.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
            );
            const filteredByProvider = filtered.reduce<Record<string, DisplayModelOption[]>>((acc, m) => {
              (acc[m.provider] ??= []).push(m);
              return acc;
            }, {});
            return Object.entries(filteredByProvider).map(([provider, providerModels]) => (
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
            ));
          })()}
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

// ─── Model Routing Section (OC-021) ──────────────────────────────────────────

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
