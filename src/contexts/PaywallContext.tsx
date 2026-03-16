import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { apiFetch, type PaywallDetail } from '../lib/apiFetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PaywallState {
  visible: boolean;
  feature?: string;
  currentPlan?: string;
  requiredPlan?: string;
  message?: string;
}

interface PaywallContextValue {
  /** Show the paywall modal programmatically */
  showPaywall: (detail?: PaywallDetail) => void;
  /** Dismiss the paywall modal */
  dismiss: () => void;
}

interface TrialInfo {
  daysRemaining: number | null;
  isTrialing: boolean;
}

const PaywallContext = createContext<PaywallContextValue | null>(null);

export function usePaywall(): PaywallContextValue {
  const ctx = useContext(PaywallContext);
  if (!ctx) throw new Error('usePaywall must be used within PaywallProvider');
  return ctx;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function PaywallProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PaywallState>({ visible: false });
  const [trial, setTrial] = useState<TrialInfo>({ daysRemaining: null, isTrialing: false });
  const [licenseMode, setLicenseMode] = useState(false);
  const [licenseKey, setLicenseKey] = useState('');
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [licenseLoading, setLicenseLoading] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  const showPaywall = useCallback((detail?: PaywallDetail) => {
    setState({
      visible: true,
      feature: detail?.feature,
      currentPlan: detail?.currentPlan,
      requiredPlan: detail?.requiredPlan,
      message: detail?.message,
    });
    setLicenseMode(false);
    setLicenseKey('');
    setLicenseError(null);
  }, []);

  const dismiss = useCallback(() => {
    setState({ visible: false });
    setLicenseMode(false);
    setLicenseKey('');
    setLicenseError(null);
  }, []);

  // Listen for 402 custom events from apiFetch
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<PaywallDetail>).detail;
      showPaywall(detail);
    };
    window.addEventListener('rorca:paywall-required', handler);
    return () => window.removeEventListener('rorca:paywall-required', handler);
  }, [showPaywall]);

  // Fetch trial info when modal opens
  useEffect(() => {
    if (!state.visible) return;
    apiFetch<{ plan: string; subscription: { status: string; currentPeriodEnd: string } | null }>('/api/billing/status', { silent: true })
      .then((data) => {
        if (data.subscription?.status === 'trialing' && data.subscription.currentPeriodEnd) {
          const end = new Date(data.subscription.currentPeriodEnd);
          const now = new Date();
          const days = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
          setTrial({ daysRemaining: days, isTrialing: true });
        } else {
          setTrial({ daysRemaining: null, isTrialing: false });
        }
      })
      .catch(() => setTrial({ daysRemaining: null, isTrialing: false }));
  }, [state.visible]);

  // Escape key dismissal
  useEffect(() => {
    if (!state.visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [state.visible, dismiss]);

  // Start free trial — create Stripe checkout for 'pro' plan
  const handleStartTrial = useCallback(async () => {
    try {
      const data = await apiFetch<{ url: string }>('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: state.requiredPlan || 'pro' }),
      });
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      // checkout creation failed — apiFetch already handles toasts
    }
  }, [state.requiredPlan]);

  // Activate license key
  const handleActivateLicense = useCallback(async () => {
    if (!licenseKey.trim()) return;
    setLicenseLoading(true);
    setLicenseError(null);
    try {
      await apiFetch('/api/billing/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: licenseKey.trim() }),
      });
      dismiss();
      // Reload to pick up new plan
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid license key';
      setLicenseError(msg);
    } finally {
      setLicenseLoading(false);
    }
  }, [licenseKey, dismiss]);

  const contextValue: PaywallContextValue = { showPaywall, dismiss };

  const planLabel = state.requiredPlan
    ? state.requiredPlan.charAt(0).toUpperCase() + state.requiredPlan.slice(1)
    : 'Pro';

  return (
    <PaywallContext.Provider value={contextValue}>
      {children}
      {state.visible && (
        <div
          ref={backdropRef}
          onClick={(e) => { if (e.target === backdropRef.current) dismiss(); }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, var(--backdrop-opacity, 0.75))',
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              padding: '32px',
              maxWidth: '440px',
              width: '90vw',
              color: 'var(--text)',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>
                Upgrade to Rorca {planLabel}
              </h2>
              <button
                onClick={dismiss}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '20px',
                  padding: '4px',
                  lineHeight: 1,
                }}
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            {/* Message */}
            {state.message && (
              <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '20px', lineHeight: '1.5' }}>
                {state.message}
              </p>
            )}

            {/* Trial banner */}
            {trial.isTrialing && trial.daysRemaining !== null && (
              <div style={{
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                border: '1px solid var(--warning)',
                borderRadius: '8px',
                padding: '12px 16px',
                marginBottom: '20px',
                fontSize: '14px',
                color: 'var(--warning)',
              }}>
                Trial active — {trial.daysRemaining} day{trial.daysRemaining !== 1 ? 's' : ''} remaining
              </div>
            )}

            {/* Features */}
            <div style={{ marginBottom: '24px' }}>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                What you get
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {[
                  'Unlimited pipeline execution',
                  'Git worktree isolation per spec',
                  'Wave-based parallel runs',
                ].map((feat) => (
                  <li key={feat} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '14px' }}>
                    <span style={{ color: 'var(--success)', fontSize: '16px', flexShrink: 0 }}>&#10003;</span>
                    {feat}
                  </li>
                ))}
              </ul>
            </div>

            {/* CTAs */}
            {!licenseMode ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {!trial.isTrialing && (
                  <button
                    onClick={handleStartTrial}
                    style={{
                      width: '100%',
                      padding: '12px',
                      backgroundColor: 'var(--accent)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Start Free Trial
                  </button>
                )}
                <button
                  onClick={() => setLicenseMode(true)}
                  style={{
                    width: '100%',
                    padding: '12px',
                    backgroundColor: 'var(--surface-200)',
                    color: 'var(--text)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Activate License
                </button>
                <a
                  href="https://rorca.app/pricing"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'block',
                    textAlign: 'center',
                    color: 'var(--accent)',
                    fontSize: '13px',
                    marginTop: '4px',
                    textDecoration: 'none',
                  }}
                >
                  Learn More
                </a>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <input
                  type="text"
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                  placeholder="Paste your license key"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') handleActivateLicense(); }}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    backgroundColor: 'var(--bg)',
                    color: 'var(--text)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '14px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
                {licenseError && (
                  <p style={{ color: 'var(--error)', fontSize: '13px', margin: 0 }}>{licenseError}</p>
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => setLicenseMode(false)}
                    style={{
                      flex: 1,
                      padding: '10px',
                      backgroundColor: 'var(--surface-200)',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      fontSize: '14px',
                      cursor: 'pointer',
                    }}
                  >
                    Back
                  </button>
                  <button
                    onClick={handleActivateLicense}
                    disabled={licenseLoading || !licenseKey.trim()}
                    style={{
                      flex: 1,
                      padding: '10px',
                      backgroundColor: 'var(--accent)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '8px',
                      fontSize: '14px',
                      fontWeight: 600,
                      cursor: licenseLoading ? 'wait' : 'pointer',
                      opacity: licenseLoading || !licenseKey.trim() ? 0.6 : 1,
                    }}
                  >
                    {licenseLoading ? 'Activating...' : 'Activate'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </PaywallContext.Provider>
  );
}
