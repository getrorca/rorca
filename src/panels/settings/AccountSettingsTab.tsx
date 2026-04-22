import { useState, useEffect } from 'react';
import { Save, Loader2, Trash2, Eye, EyeOff, Check, Mail, AlertTriangle, Zap, XCircle, Crown, Users, ChevronDown, ChevronUp, Download, ExternalLink, FileText, Shield, Sun, Moon, Monitor } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { apiFetch, clearTokens } from '../../lib/apiFetch';
import { AnimatedModal } from '../../components/AnimatedModal';
import { useGlobalToast } from '../../contexts/ToastContext';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProfileData {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

interface NotificationPreferences {
  [eventType: string]: { inApp: boolean; email: boolean };
}

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
  selfHostedLicense?: { set: boolean; valid: boolean; plan?: string; expiresAt?: string | null; error?: string };
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

// ─── Constants ──────────────────────────────────────────────────────────────

const EVENT_TYPE_LABELS: Record<string, string> = {
  review_request: 'Review Requests',
  spec_approved: 'Spec Approved',
  spec_rejected: 'Spec Rejected',
  pipeline_completed: 'Pipeline Completed',
  budget_alert: 'Budget Alerts',
  mention: 'Mentions',
};

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

// ─── Account Section (Profile + Notifications + Telemetry + Danger Zone) ────

export function AccountSettingsTab() {
  return (
    <div className="max-w-lg space-y-8">
      <ProfileSection />
      <div className="border-t border-border pt-6">
        <ThemeSection />
      </div>
      <div className="border-t border-border pt-6">
        <NotificationsSection />
      </div>
      <div className="border-t border-border pt-6">
        <TelemetrySection />
      </div>
      <div className="border-t border-border pt-6">
        <AccountDeletionSection />
      </div>
    </div>
  );
}

// ─── Theme Section ──────────────────────────────────────────────────────────

const THEME_OPTIONS = [
  { mode: 'system' as const, icon: Monitor, label: 'System', description: 'Follow OS preference' },
  { mode: 'light' as const, icon: Sun, label: 'Light', description: 'Always light' },
  { mode: 'dark' as const, icon: Moon, label: 'Dark', description: 'Always dark' },
];

function ThemeSection() {
  const { mode, setMode } = useTheme();
  return (
    <div>
      <h3 className="text-sm font-semibold text-text mb-1">Appearance</h3>
      <p className="text-xs text-muted mb-3">Choose your preferred theme. System follows your OS setting.</p>
      <div className="flex gap-2">
        {THEME_OPTIONS.map(opt => {
          const Icon = opt.icon;
          const active = mode === opt.mode;
          return (
            <button
              key={opt.mode}
              onClick={() => setMode(opt.mode)}
              className={`flex-1 flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg border text-xs font-medium transition-colors ${
                active
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-panel text-muted hover:text-text hover:border-border'
              }`}
            >
              <Icon size={18} />
              <span>{opt.label}</span>
            </button>
          );
        })}
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
                <span className="text-amber-400">Email verification is managed by Supabase</span>
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

export function NotificationsSection() {
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

// ─── Telemetry Section ───────────────────────────────────────────────────────

function TelemetrySection() {
  const [telemetryStatus, setTelemetryStatus] = useState<{ enabled: boolean; note: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ enabled: boolean; note: string }>('/api/telemetry/status')
      .then(data => setTelemetryStatus(data))
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center gap-2 text-muted text-sm"><Loader2 size={16} className="animate-spin" /> Loading telemetry settings...</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2 mb-2">
          <Shield size={16} className="text-accent" />
          Privacy & Telemetry
        </h2>
        <p className="text-xs text-muted">
          Help improve Rorca by sending anonymous usage statistics. No spec content, code, or file paths are ever sent.
        </p>
      </div>

      <div className="border border-border rounded p-3 bg-surface-100 space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <p className="text-sm text-[var(--text)] font-medium">Anonymous telemetry</p>
            <p className="text-xs text-muted mt-0.5">
              {telemetryStatus?.enabled
                ? 'Enabled — Rorca is sending anonymous metrics to help us improve the product.'
                : 'Disabled (default) — No data is being collected or sent.'}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-surface-200 text-muted">
            {telemetryStatus?.enabled ? (
              <>
                <Check size={12} className="text-green-500" />
                <span>ON</span>
              </>
            ) : (
              <>
                <XCircle size={12} className="text-muted" />
                <span>OFF</span>
              </>
            )}
          </div>
        </div>

        <div className="text-xs text-muted bg-bg rounded p-2 space-y-1">
          <p className="font-medium text-[var(--text)]">When enabled, we collect:</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Event type (spec generated, run completed)</li>
            <li>Agent type (claude, opencode, codex)</li>
            <li>Story count and duration</li>
          </ul>
        </div>

        <div className="text-xs text-muted bg-bg rounded p-2 space-y-1">
          <p className="font-medium text-[var(--text)]">We NEVER collect:</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Spec content, code, or file paths</li>
            <li>Workspace names or organization info</li>
            <li>API keys or credentials</li>
            <li>Personal information (email, IP, device)</li>
          </ul>
        </div>

        <p className="text-xs text-muted">
          Telemetry is controlled by the <span className="font-mono bg-bg px-1.5 py-0.5 rounded text-[11px]">RORCA_TELEMETRY</span> environment variable. See{' '}
          <a
            href="https://github.com/anthropics/rorca/blob/main/PRIVACY.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            PRIVACY.md
          </a>{' '}
          for details.
        </p>
      </div>
    </div>
  );
}

// ─── Account Deletion Section ─────────────────────────────────────────────────

function AccountDeletionSection() {
  const { show: showToast } = useGlobalToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!password) return;
    setDeleting(true);
    setError(null);
    try {
      await apiFetch('/api/users/me', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      clearTokens();
      setModalOpen(false);
      showToast('Your account has been deleted', 'success');
      setTimeout(() => { window.location.href = '/'; }, 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to delete account');
    } finally {
      setDeleting(false);
    }
  };

  const closeModal = () => {
    if (deleting) return;
    setModalOpen(false);
    setPassword('');
    setError(null);
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
              This will permanently delete your personal data, API keys, and credentials.
              Operational records (pipeline runs, comments) will be anonymized. This cannot be undone.
            </p>
          </div>
        </div>

        <button
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
        >
          <Trash2 size={14} />
          Delete Account
        </button>
      </div>

      <AnimatedModal isOpen={modalOpen} onClose={closeModal} closeOnBackdropClick={!deleting}>
        <div className="w-[420px] bg-panel border border-border rounded-lg shadow-xl overflow-hidden">
          {/* Red header */}
          <div className="bg-red-600 px-6 py-4">
            <h2 className="text-base font-semibold text-white">Delete Account</h2>
          </div>

          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-muted">
              This action cannot be undone. Enter your password to confirm.
            </p>

            <div>
              <label className="block text-xs text-muted mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password"
                readOnly={deleting}
                className="w-full px-3 py-2 text-sm bg-bg border border-border rounded focus:border-red-500 outline-none read-only:opacity-60"
                autoFocus
              />
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex gap-2 pt-2">
              <button
                onClick={handleDelete}
                disabled={!password || deleting}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Deleting your account...
                  </>
                ) : (
                  <>
                    <Trash2 size={14} />
                    Delete My Account
                  </>
                )}
              </button>
              <button
                onClick={closeModal}
                disabled={deleting}
                className="px-4 py-2 text-sm text-muted hover:text-[var(--text)] disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </AnimatedModal>

    </div>
  );
}

// ─── Billing Section ─────────────────────────────────────────────────────────

export function BillingSection() {
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
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg border border-current/20 flex items-center justify-center shrink-0">
              <PlanIcon size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
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
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-current/10">
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
          <div className="border border-border rounded overflow-hidden overflow-x-auto">
            <div className="min-w-[400px]">
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

      {/* Self-Hosted License */}
      <div className="border-t border-border pt-6">
        <h3 className="text-sm font-semibold text-[var(--text)] mb-2">Self-Hosted License</h3>
        <p className="text-xs text-muted mb-3">
          Self-hosted instances can activate with an offline license key via the <code className="px-1 py-0.5 bg-bg rounded text-[10px] font-mono border border-border">RORCA_LICENSE_KEY</code> environment variable. No network call required.
        </p>

        {status.selfHostedLicense?.set ? (
          <div className={`border rounded-lg p-4 ${
            status.selfHostedLicense.valid
              ? 'border-green-500/30 bg-green-500/5'
              : 'border-red-500/30 bg-red-500/5'
          }`}>
            <div className="flex items-center gap-2 mb-2">
              {status.selfHostedLicense.valid ? (
                <>
                  <Shield size={14} className="text-green-500" />
                  <span className="text-sm font-medium text-green-500">Valid License</span>
                  <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-green-500/15 text-green-500">
                    {status.selfHostedLicense.plan}
                  </span>
                </>
              ) : (
                <>
                  <XCircle size={14} className="text-red-500" />
                  <span className="text-sm font-medium text-red-500">Invalid License</span>
                </>
              )}
            </div>
            {status.selfHostedLicense.valid && status.selfHostedLicense.expiresAt && (
              <p className="text-xs text-muted">
                Expires: {new Date(status.selfHostedLicense.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            )}
            {status.selfHostedLicense.valid && !status.selfHostedLicense.expiresAt && (
              <p className="text-xs text-muted">Perpetual license (no expiry)</p>
            )}
            {!status.selfHostedLicense.valid && status.selfHostedLicense.error && (
              <p className="text-xs text-red-400">{status.selfHostedLicense.error}</p>
            )}
          </div>
        ) : (
          <div className="border border-border rounded-lg p-4 bg-bg">
            <p className="text-xs text-muted mb-2">
              <code className="px-1 py-0.5 bg-bg rounded text-[10px] font-mono border border-border">RORCA_LICENSE_KEY</code> is not set.
            </p>
            <p className="text-xs text-muted">
              To activate, add to your environment:
            </p>
            <pre className="mt-2 p-2 bg-[var(--bg-darker,#111)] rounded text-[10px] font-mono text-muted overflow-x-auto border border-border">
              RORCA_LICENSE_KEY=eyJhbGciOiJSUzI1NiIs...
            </pre>
            <p className="text-xs text-muted mt-2">
              Then restart the backend. The license is verified locally — no network call to rorca.app required.
            </p>
          </div>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <AlertTriangle size={12} />
          {error}
        </p>
      )}
    </div>
  );
}
