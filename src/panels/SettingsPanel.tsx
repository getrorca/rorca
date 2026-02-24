import { useState, useEffect, useCallback } from 'react';
import { User, Bell, Key, Monitor, Save, Loader2, Trash2, Plus, Eye, EyeOff, Check, Mail } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTheme, type ThemeMode } from '../contexts/ThemeContext';
import { apiFetch } from '../lib/apiFetch';

// ─── Types ───────────────────────────────────────────────────────────────────

type SettingsTab = 'profile' | 'notifications' | 'api-keys' | 'display';

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
  spend_total_usd: number;
  last_used_at: string | null;
  created_at: string;
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
  { id: 'api-keys', label: 'API Keys', icon: Key },
  { id: 'display', label: 'Display', icon: Monitor },
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
          {activeTab === 'api-keys' && <ApiKeysSection />}
          {activeTab === 'display' && <DisplaySection />}
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

// ─── API Keys Section ────────────────────────────────────────────────────────

function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addProvider, setAddProvider] = useState('anthropic');
  const [addLabel, setAddLabel] = useState('');
  const [addKey, setAddKey] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const fetchKeys = useCallback(async () => {
    try {
      const data = await apiFetch<{ keys: ApiKeyEntry[] }>('/api/vault/keys');
      setKeys(data.keys);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  const addApiKey = async () => {
    setAdding(true);
    setAddError(null);
    try {
      await apiFetch('/api/vault/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: addProvider, key: addKey, label: addLabel }),
      });
      setAddKey('');
      setAddLabel('');
      setShowAdd(false);
      fetchKeys();
    } catch (err: any) {
      setAddError(err.message || 'Failed to add key');
    } finally {
      setAdding(false);
    }
  };

  const removeKey = async (id: string) => {
    try {
      await apiFetch(`/api/vault/keys/${id}`, { method: 'DELETE' });
      setKeys(prev => prev.filter(k => k.id !== id));
    } catch {
      // silent
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading API keys...</div>;
  }

  return (
    <div className="max-w-lg space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">API Keys</h2>
          <p className="text-xs text-muted mt-0.5">Bring Your Own Key (BYOB) — stored encrypted, never sent to Rorcha servers</p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 transition-colors"
        >
          <Plus size={14} /> Add Key
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="border border-border rounded p-4 space-y-3 bg-bg">
          <div>
            <label className="block text-xs text-muted mb-1">Provider</label>
            <select
              value={addProvider}
              onChange={e => setAddProvider(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-panel border border-border rounded focus:border-accent outline-none"
            >
              {PROVIDER_OPTIONS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Label (optional)</label>
            <input
              type="text"
              value={addLabel}
              onChange={e => setAddLabel(e.target.value)}
              placeholder="e.g. Personal, Work"
              className="w-full px-3 py-2 text-sm bg-panel border border-border rounded focus:border-accent outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">API Key</label>
            <input
              type="password"
              value={addKey}
              onChange={e => setAddKey(e.target.value)}
              placeholder="sk-..."
              className="w-full px-3 py-2 text-sm bg-panel border border-border rounded focus:border-accent outline-none font-mono"
            />
          </div>
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <div className="flex gap-2">
            <button
              onClick={addApiKey}
              disabled={adding || !addKey}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Add
            </button>
            <button
              onClick={() => { setShowAdd(false); setAddError(null); }}
              className="px-4 py-2 text-sm text-muted hover:text-[var(--text)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Keys list */}
      {keys.length === 0 && !showAdd ? (
        <div className="text-sm text-muted py-8 text-center border border-dashed border-border rounded">
          No API keys stored. Add one to use Rorcha with your own LLM provider.
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map(k => (
            <div key={k.id} className="flex items-center justify-between px-4 py-3 border border-border rounded bg-bg">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium px-2 py-0.5 rounded bg-accent/10 text-accent">{k.provider}</span>
                  {k.label && <span className="text-sm text-[var(--text)] truncate">{k.label}</span>}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                  <span className="font-mono">{k.masked_key}</span>
                  {k.spend_total_usd > 0 && <span>${k.spend_total_usd.toFixed(2)} spent</span>}
                  {k.last_used_at && <span>Last used {new Date(k.last_used_at).toLocaleDateString()}</span>}
                </div>
              </div>
              <button
                onClick={() => removeKey(k.id)}
                className="p-1.5 text-muted hover:text-red-500 transition-colors"
                title="Remove key"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
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
