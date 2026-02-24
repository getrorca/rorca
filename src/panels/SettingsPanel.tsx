import { useState, useEffect, useCallback } from 'react';
import { User, Bell, Key, Monitor, Save, Loader2, Trash2, Plus, Eye, EyeOff, Check, Mail, AlertTriangle, Zap, Globe, CheckCircle2, XCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useTheme, type ThemeMode } from '../contexts/ThemeContext';
import { apiFetch, clearTokens } from '../lib/apiFetch';

// ─── Types ───────────────────────────────────────────────────────────────────

type SettingsTab = 'profile' | 'notifications' | 'providers' | 'display' | 'account';

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
}

const TABS: { id: SettingsTab; label: string; icon: typeof User }[] = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'providers', label: 'Providers', icon: Zap },
  { id: 'display', label: 'Display', icon: Monitor },
  { id: 'account', label: 'Account', icon: AlertTriangle },
];

const EVENT_TYPE_LABELS: Record<string, string> = {
  review_request: 'Review Requests',
  spec_approved: 'Spec Approved',
  spec_rejected: 'Spec Rejected',
  pipeline_completed: 'Pipeline Completed',
  budget_alert: 'Budget Alerts',
  mention: 'Mentions',
};

const PROVIDER_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai-compat', label: 'OpenAI Compatible' },
];

// ─── Component ───────────────────────────────────────────────────────────────

export default function SettingsPanel() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 sm:p-6 border-b border-border shrink-0">
        <h1 className="text-lg font-semibold text-[var(--text)]">Settings</h1>
        <p className="text-xs text-muted mt-1">Manage your profile, notifications, API keys, and display preferences</p>
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
              {label}
            </button>
          ))}
        </nav>

        {/* Mobile tab bar */}
        <div className="sm:hidden flex border-b border-border bg-panel shrink-0">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs transition-colors ${
                activeTab === id
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-muted'
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {activeTab === 'profile' && <ProfileSection />}
          {activeTab === 'notifications' && <NotificationsSection />}
          {activeTab === 'providers' && <ProvidersSection />}
          {activeTab === 'display' && <DisplaySection />}
          {activeTab === 'account' && <AccountDeletionSection />}
        </div>
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
  const [avatarUrl, setAvatarUrl] = useState('');

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
    apiFetch<ProfileData>('/api/settings/profile')
      .then(data => {
        setProfile(data);
        setDisplayName(data.displayName);
        setAvatarUrl(data.avatarUrl ?? '');
      })
      .catch(() => setError('Failed to load profile'))
      .finally(() => setLoading(false));
  }, []);

  const saveProfile = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch('/api/settings/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, avatarUrl: avatarUrl || null }),
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
      await apiFetch('/api/settings/password', {
        method: 'PUT',
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

  const hasProfileChanges = profile && (displayName !== profile.displayName || (avatarUrl || '') !== (profile.avatarUrl ?? ''));

  return (
    <div className="max-w-lg space-y-6">
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

          <div>
            <label className="block text-xs text-muted mb-1">Avatar URL</label>
            <input
              type="url"
              value={avatarUrl}
              onChange={e => setAvatarUrl(e.target.value)}
              placeholder="https://example.com/avatar.png"
              className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
            />
            {avatarUrl && (
              <div className="mt-2">
                <img src={avatarUrl} alt="Avatar preview" className="w-10 h-10 rounded-full object-cover border border-border" onError={e => (e.currentTarget.style.display = 'none')} />
              </div>
            )}
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
    <div className="max-w-lg space-y-4">
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

// ─── Providers Section ──────────────────────────────────────────────────────

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  'claude-cli': 'Uses your Claude subscription via the claude CLI. No API key needed.',
  'anthropic': 'Direct API access to Claude models. Requires an Anthropic API key.',
  'openai-compat': 'Any OpenAI-compatible endpoint (OpenAI, Groq, Together, DeepSeek, Ollama, etc.).',
  'openrouter': 'Access 200+ models through a single API key.',
};

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
    <div className="max-w-2xl space-y-6">
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
                  {/* Test button */}
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
                  {/* Add key button (not for claude-cli) */}
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

function DisplaySection() {
  const { mode, setMode } = useTheme();
  const [settings, setSettings] = useState<DisplaySettings | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [defaultModel, setDefaultModel] = useState('claude-sonnet-4-5-20250929');
  const [itemsPerPage, setItemsPerPage] = useState(20);

  useEffect(() => {
    Promise.all([
      apiFetch<DisplaySettings>('/api/settings/display'),
      apiFetch<{ models: ModelOption[] }>('/api/direction/models'),
    ]).then(([displayData, modelData]) => {
      setSettings(displayData);
      setDefaultModel(displayData.defaultModel);
      setItemsPerPage(displayData.itemsPerPage);
      setModels(modelData.models);
    }).catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const saveDisplay = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await apiFetch('/api/settings/display', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultModel, itemsPerPage }),
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
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading display settings...</div>;
  }

  const hasChanges = settings && (defaultModel !== settings.defaultModel || itemsPerPage !== settings.itemsPerPage);

  return (
    <div className="max-w-lg space-y-6">
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

      <div className="border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-[var(--text)] mb-4">Default Model</h2>
        <select
          value={defaultModel}
          onChange={e => setDefaultModel(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-accent outline-none"
        >
          {models.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <p className="text-xs text-muted mt-1">Used as the default when generating specs</p>
      </div>

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
      // Account deleted — clear local state and redirect
      clearTokens();
      window.location.href = '/';
    } catch (err: any) {
      setError(err.message || 'Failed to delete account');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
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
