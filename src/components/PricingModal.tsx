/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect } from 'react';
import { X, Check, Loader2, Zap, Crown, Users } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useFocusTrap } from '../hooks/useFocusTrap';

const PLANS = [
  {
    id: 'solo' as const,
    name: 'Solo',
    price: 10,
    icon: Zap,
    features: [
      'Pipeline execution',
      '3 workspaces',
      'Full spec generation',
      'Direction stack',
    ],
  },
  {
    id: 'pro' as const,
    name: 'Pro',
    price: 25,
    icon: Crown,
    popular: true,
    features: [
      'Everything in Solo',
      'Unlimited workspaces',
      'Git worktree isolation',
      'Priority support',
    ],
  },
  {
    id: 'team' as const,
    name: 'Team',
    price: 59,
    icon: Users,
    features: [
      'Everything in Pro',
      'Team collaboration',
      'Shared direction',
      'Admin controls',
    ],
  },
];

interface PricingModalProps {
  onClose: () => void;
}

export default function PricingModal({ onClose }: PricingModalProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCheckout = async (planId: string) => {
    setLoading(planId);
    setError('');
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
        setLoading(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start checkout');
      setLoading(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Upgrade your plan"
    >
      <div
        ref={trapRef}
        className="bg-panel border border-border rounded-lg shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)]">Upgrade Your Plan</h2>
            <p className="text-sm text-muted mt-1">Pipeline execution requires a paid plan. Choose the plan that fits your needs.</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-[var(--text)] transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Plans grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-6">
          {PLANS.map((plan) => {
            const Icon = plan.icon;
            return (
              <div
                key={plan.id}
                className={`relative flex flex-col rounded-lg border p-5 ${
                  plan.popular
                    ? 'border-accent bg-accent/5 shadow-md'
                    : 'border-border'
                }`}
              >
                {plan.popular && (
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-accent text-white rounded-full">
                    Popular
                  </span>
                )}
                <div className="flex items-center gap-2 mb-3">
                  <Icon size={18} className={plan.popular ? 'text-accent' : 'text-muted'} />
                  <span className="font-medium text-[var(--text)]">{plan.name}</span>
                </div>
                <div className="mb-4">
                  <span className="text-2xl font-bold text-[var(--text)]">${plan.price}</span>
                  <span className="text-sm text-muted">/month</span>
                </div>
                <ul className="flex-1 space-y-2 mb-5">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-muted">
                      <Check size={14} className="mt-0.5 text-green-500 shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => handleCheckout(plan.id)}
                  disabled={!!loading}
                  className={`w-full py-2 rounded text-sm font-medium transition-colors ${
                    plan.popular
                      ? 'bg-accent text-white hover:opacity-90'
                      : 'bg-bg border border-border text-[var(--text)] hover:border-accent'
                  } disabled:opacity-50`}
                >
                  {loading === plan.id ? (
                    <span className="flex items-center justify-center gap-1.5">
                      <Loader2 size={14} className="animate-spin" /> Redirecting...
                    </span>
                  ) : (
                    `Get ${plan.name}`
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="px-6 pb-4">
            <p className="text-sm text-red-500">{error}</p>
          </div>
        )}

        <div className="px-6 pb-6 text-center">
          <p className="text-xs text-muted">
            You bring your own Claude subscription or API key. Rorca never pays for inference.
          </p>
        </div>
      </div>
    </div>
  );
}
