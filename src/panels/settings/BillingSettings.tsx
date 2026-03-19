import { useState, useEffect } from 'react';
import {
  Loader2, Check, AlertTriangle, Zap, Crown, Users, ExternalLink,
  FileText, Download, ChevronDown, ChevronUp, Key, Shield, Clock,
} from 'lucide-react';
import { apiFetch } from '../../lib/apiFetch';
import { useGlobalToast } from '../../contexts/ToastContext';

// ─── Types ───────────────────────────────────────────────────────────────────

interface BillingStatus {
  plan: string;
  subscription: {
    status: string;
    plan: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    stripeSubscriptionId: string | null;
  } | null;
  licenseKey: string | null;
  activatedAt: string | null;
  expiresAt: string | null;
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

// ─── Constants ──────────────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return 'N/A';
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function getDaysRemaining(expiresAt: string): number {
  const now = new Date();
  const exp = new Date(expiresAt);
  return Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}

type PlanState = 'no_plan' | 'trialing' | 'active_stripe' | 'active_license' | 'canceled';

function derivePlanState(status: BillingStatus): PlanState {
  const sub = status.subscription;
  if (!sub) return 'no_plan';

  if (sub.status === 'trialing') return 'trialing';
  if (sub.status === 'canceled' || sub.status === 'expired') return 'canceled';

  // Active subscription — distinguish Stripe vs license
  if (sub.status === 'active') {
    if (status.licenseKey) return 'active_license';
    return 'active_stripe';
  }

  // past_due counts as active_stripe (still has access)
  if (sub.status === 'past_due') return 'active_stripe';

  return 'no_plan';
}

// ─── Plan Status Badge ──────────────────────────────────────────────────────

function PlanBadge({ state, status }: { state: PlanState; status: BillingStatus }) {
  const sub = status.subscription;
  const daysRemaining = sub?.currentPeriodEnd ? getDaysRemaining(sub.currentPeriodEnd) : 0;

  switch (state) {
    case 'trialing':
      return (
        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-blue-500/15 text-blue-400">
          Free Trial ({daysRemaining} days remaining)
        </span>
      );
    case 'active_stripe':
      return (
        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-green-500/15 text-green-500">
          Pro (Active)
        </span>
      );
    case 'active_license':
      return (
        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-green-500/15 text-green-500">
          Pro (License)
        </span>
      );
    case 'canceled':
      return (
        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-red-500/15 text-red-500">
          Expired
        </span>
      );
    case 'no_plan':
    default:
      return (
        <span className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-zinc-500/15 text-zinc-400">
          No Plan
        </span>
      );
  }
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function BillingSettings() {
  const { show: showToast } = useGlobalToast();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Portal / checkout
  const [portalLoading, setPortalLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [showAllInvoices, setShowAllInvoices] = useState(false);

  // License activation
  const [licenseInput, setLicenseInput] = useState('');
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [licenseError, setLicenseError] = useState<string | null>(null);

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

  // ─── Actions ────────────────────────────────────────────────────────────

  const openPortal = async () => {
    setPortalLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ url?: string; error?: string }>('/api/billing/portal', { method: 'POST' });
      if (res.url) window.open(res.url, '_blank');
      else setError(res.error || 'Failed to open billing portal');
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
      const res = await apiFetch<{ url?: string; checkoutUrl?: string; error?: string }>('/api/billing/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planId }),
      });
      const url = res.checkoutUrl || res.url;
      if (url) window.location.href = url;
      else setError(res.error || 'Failed to start checkout');
    } catch (err: any) {
      setError(err.message || 'Failed to start checkout');
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handleActivateLicense = async () => {
    if (!licenseInput.trim()) return;
    setLicenseLoading(true);
    setLicenseError(null);
    try {
      const res = await apiFetch<{ activated: boolean; plan: string; expiresAt: string | null; error?: string }>(
        '/api/billing/activate-license',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey: licenseInput.trim() }),
        }
      );
      if (res.activated) {
        showToast('License activated successfully', 'success');
        setLicenseInput('');
        // Refresh billing status
        const refreshed = await apiFetch<BillingStatus>('/api/billing/status');
        setStatus(refreshed);
      } else {
        setLicenseError(res.error || 'Activation failed');
      }
    } catch (err: any) {
      setLicenseError(err.message || 'Invalid license key');
    } finally {
      setLicenseLoading(false);
    }
  };

  // ─── Loading / Error ────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted text-sm">
        <Loader2 size={16} className="animate-spin" /> Loading billing...
      </div>
    );
  }

  if (!status) {
    return <p className="text-sm text-red-500">{error || 'Failed to load billing'}</p>;
  }

  // ─── Derived state ──────────────────────────────────────────────────────

  const planState = derivePlanState(status);
  const currentPlan = status.plan;
  const planInfo = status.plans[currentPlan];
  const PlanIcon = PLAN_ICONS[currentPlan] || Zap;
  const planColor = PLAN_COLORS[currentPlan] || PLAN_COLORS.free;
  const isPaid = currentPlan !== 'free';
  const renewalDate = status.subscription?.currentPeriodEnd || null;
  const visibleInvoices = showAllInvoices ? invoices : invoices.slice(0, 5);

  // Trial progress (0-1)
  const trialProgress = planState === 'trialing' && status.subscription?.currentPeriodStart && status.subscription?.currentPeriodEnd
    ? (() => {
        const start = new Date(status.subscription!.currentPeriodStart!).getTime();
        const end = new Date(status.subscription!.currentPeriodEnd!).getTime();
        const now = Date.now();
        if (end <= start) return 1;
        return Math.min(1, Math.max(0, (now - start) / (end - start)));
      })()
    : 0;

  return (
    <div className="max-w-2xl space-y-6">
      {/* ── Current Plan Card ──────────────────────────────────────────── */}
      <div className={`border rounded-lg p-5 ${planColor}`}>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg border border-current/20 flex items-center justify-center shrink-0">
              <PlanIcon size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-semibold">{planInfo?.name || 'Free'} Plan</h2>
                <PlanBadge state={planState} status={status} />
              </div>
              {isPaid && planInfo && (
                <p className="text-sm mt-0.5 opacity-80">${planInfo.priceMonthly}/month</p>
              )}
              {!isPaid && (
                <p className="text-xs mt-0.5 opacity-70">Upgrade to unlock pipeline execution</p>
              )}
            </div>
          </div>

          {/* Manage button for Stripe-active plans */}
          {planState === 'active_stripe' && status.stripeConfigured && (
            <button
              onClick={openPortal}
              disabled={portalLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-current/20 rounded hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              {portalLoading ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
              Manage Subscription
            </button>
          )}
        </div>

        {/* ── Trial state: expiry date, days remaining, progress bar ── */}
        {planState === 'trialing' && (
          <div className="mt-4 pt-4 border-t border-current/10 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Trial Expires</p>
                <p className="text-sm font-medium">{formatDate(renewalDate)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Days Remaining</p>
                <p className="text-sm font-medium">{renewalDate ? getDaysRemaining(renewalDate) : 0} days</p>
              </div>
            </div>
            <div>
              <div className="flex justify-between text-[10px] text-muted mb-1">
                <span>Trial progress</span>
                <span>{Math.round(trialProgress * 100)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-current/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${trialProgress * 100}%` }}
                />
              </div>
            </div>
            <button
              onClick={() => handleCheckout('pro')}
              disabled={!!checkoutLoading}
              className="w-full py-2 rounded text-sm font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {checkoutLoading === 'pro' ? (
                <span className="flex items-center justify-center gap-1.5">
                  <Loader2 size={14} className="animate-spin" /> Redirecting...
                </span>
              ) : 'Upgrade Now'}
            </button>
          </div>
        )}

        {/* ── Active Stripe: renewal date + seats ── */}
        {planState === 'active_stripe' && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-current/10">
            <div>
              <p className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Renewal Date</p>
              <p className="text-sm font-medium">{formatDate(renewalDate)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Seats</p>
              <p className="text-sm font-medium">
                {status.seats.used} used{status.seats.limit ? ` / ${status.seats.limit} max` : ' (unlimited)'}
              </p>
            </div>
          </div>
        )}

        {/* ── Active License: key, activation date, expiry date ── */}
        {planState === 'active_license' && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-current/10">
            <div>
              <p className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">License Key</p>
              <p className="text-sm font-medium font-mono">{status.licenseKey || 'N/A'}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Activated</p>
              <p className="text-sm font-medium">{formatDate(status.activatedAt)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider opacity-60 mb-0.5">Expires</p>
              <p className="text-sm font-medium">{formatDate(status.expiresAt)}</p>
            </div>
          </div>
        )}

        {/* ── Canceled/Expired: renew button ── */}
        {planState === 'canceled' && status.stripeConfigured && (
          <div className="mt-4 pt-4 border-t border-current/10">
            <p className="text-xs text-muted mb-3">
              Your subscription has expired. Renew to regain access to pipeline execution and all Pro features.
            </p>
            <button
              onClick={() => handleCheckout('pro')}
              disabled={!!checkoutLoading}
              className="px-4 py-2 rounded text-sm font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {checkoutLoading === 'pro' ? (
                <span className="flex items-center justify-center gap-1.5">
                  <Loader2 size={14} className="animate-spin" /> Redirecting...
                </span>
              ) : 'Renew Subscription'}
            </button>
          </div>
        )}
      </div>

      {/* ── Activate License Key ──────────────────────────────────────── */}
      <div className="border border-border rounded-lg p-5">
        <div className="flex items-center gap-2 mb-3">
          <Key size={16} className="text-muted" />
          <h3 className="text-sm font-semibold text-[var(--text)]">Activate License Key</h3>
        </div>
        <p className="text-xs text-muted mb-3">
          If you have an offline license key, enter it below to activate your plan without Stripe.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={licenseInput}
            onChange={(e) => {
              setLicenseInput(e.target.value);
              setLicenseError(null);
            }}
            placeholder="Paste license key..."
            className="flex-1 px-3 py-2 text-sm rounded border border-border bg-bg text-[var(--text)] placeholder:text-muted focus:outline-none focus:border-accent/60 transition-colors font-mono"
          />
          <button
            onClick={handleActivateLicense}
            disabled={licenseLoading || !licenseInput.trim()}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {licenseLoading ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
            Activate
          </button>
        </div>
        {licenseError && (
          <p className="text-xs text-red-500 mt-2 flex items-center gap-1">
            <AlertTriangle size={12} />
            {licenseError}
          </p>
        )}
      </div>

      {/* ── Plan Comparison ───────────────────────────────────────────── */}
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
                  {plan.features.map((f) => (
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

      {/* ── Invoice History ───────────────────────────────────────────── */}
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
              {visibleInvoices.map((inv) => (
                <div key={inv.id} className="grid grid-cols-[1fr_80px_80px_60px] gap-2 px-4 py-2.5 border-b border-border last:border-b-0 items-center">
                  <div className="min-w-0">
                    <p className="text-sm text-[var(--text)] truncate">{inv.number || inv.id.slice(0, 16)}</p>
                    <p className="text-[10px] text-muted capitalize">{inv.status}</p>
                  </div>
                  <span className="text-sm text-[var(--text)]">
                    ${(inv.amountPaid / 100).toFixed(2)}
                  </span>
                  <span className="text-xs text-muted">
                    {inv.created ? new Date(inv.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '\u2014'}
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

      {/* ── General Error ─────────────────────────────────────────────── */}
      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <AlertTriangle size={12} />
          {error}
        </p>
      )}
    </div>
  );
}
