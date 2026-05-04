/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { X, Crown, ArrowRight } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useFocusTrap } from '../hooks/useFocusTrap';

// ─── Types ────────────────────────────────────────────────────────────────────

interface QuotaEntry {
  feature: string;
  limit: number;
  used: number;
  remaining: number | null;
}

interface QuotaResponse {
  plan: string;
  quotas: QuotaEntry[];
}

export interface UpgradePromptProps {
  /** Identifier matching a quota feature key (e.g. 'exa_search', 'marketplace_publish') */
  feature: string;
  /** Human-readable feature name shown in the prompt */
  featureName: string;
  /** One-line explanation of what upgrading unlocks */
  description: string;
  /** Whether the prompt is currently visible */
  open: boolean;
  /** Called when the user dismisses the prompt */
  onClose: () => void;
  /** Callback to navigate to billing — defaults to setting hash to #billing */
  onUpgrade?: () => void;
}

// ─── Session-level dismiss cache ─────────────────────────────────────────────

const sessionDismissed = new Set<string>();

// ─── Pro Badge ────────────────────────────────────────────────────────────────

/**
 * Inline badge: shows "Pro" pill next to a feature name.
 * Usage: <ProBadge />
 */
export function ProBadge() {
  return (
    <span
      className="inline-flex items-center gap-0.5 px-2 py-0.5 text-xs font-semibold rounded-full bg-accent/20 text-accent"
      aria-label="Pro feature"
    >
      <Crown size={10} />
      Pro
    </span>
  );
}

// ─── Inline Upgrade Prompt ────────────────────────────────────────────────────

/**
 * Inline variant: replaces gated content inside a panel.
 * Shows a muted box with upgrade CTA.
 */
export function UpgradePromptInline({
  featureName,
  description,
  onUpgrade,
}: Pick<UpgradePromptProps, 'featureName' | 'description' | 'onUpgrade'>) {
  const handleUpgrade = onUpgrade ?? (() => {
    window.location.hash = '#billing';
  });

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8 px-6 rounded-lg border border-border bg-panel text-center">
      <div className="flex items-center justify-center w-10 h-10 rounded-full bg-accent/10">
        <Crown size={18} className="text-accent" />
      </div>
      <div>
        <p className="text-sm font-medium text-[var(--text)]">{featureName} requires Pro</p>
        <p className="text-xs text-muted mt-1">{description}</p>
      </div>
      <button
        onClick={handleUpgrade}
        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-accent text-white rounded hover:bg-accent/90 transition-colors"
      >
        Upgrade to Pro
        <ArrowRight size={14} />
      </button>
    </div>
  );
}

// ─── Modal Upgrade Prompt ─────────────────────────────────────────────────────

/**
 * Modal variant: shown when a free user attempts a gated action.
 * Fetches quota info to show accurate usage count.
 * Dismissible with X button or Escape; does NOT reappear for the same feature
 * in the same session.
 */
export function UpgradePromptModal({
  feature,
  featureName,
  description,
  open,
  onClose,
  onUpgrade,
}: UpgradePromptProps) {
  const [quota, setQuota] = useState<QuotaEntry | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open);

  const handleClose = useCallback(() => {
    sessionDismissed.add(feature);
    onClose();
  }, [feature, onClose]);

  const handleUpgrade = onUpgrade ?? (() => {
    window.location.hash = '#billing';
    handleClose();
  });

  // Fetch quota info when modal opens
  useEffect(() => {
    if (!open) return;
    apiFetch<QuotaResponse>('/api/billing/quotas')
      .then((res) => {
        const q = res.quotas.find((q) => q.feature === feature);
        if (q) setQuota(q);
      })
      .catch(() => {/* silent */});
  }, [open, feature]);

  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, handleClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Upgrade required for ${featureName}`}
    >
      <div
        ref={trapRef}
        className="bg-panel border border-border rounded-lg shadow-xl w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-0">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-accent/10 shrink-0">
            <Crown size={18} className="text-accent" />
          </div>
          <button
            onClick={handleClose}
            className="text-muted hover:text-[var(--text)] transition-colors -mt-0.5"
            aria-label="Dismiss"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          <h2 className="text-base font-semibold text-[var(--text)] mt-2">{featureName} is a Pro feature</h2>
          <p className="text-sm text-muted mt-1">{description}</p>

          {/* Quota usage line */}
          {quota && quota.limit > 0 && (
            <p className="text-xs text-muted mt-3 px-3 py-2 rounded bg-bg border border-border">
              You've used <span className="font-medium text-[var(--text)]">{quota.used}</span> of{' '}
              <span className="font-medium text-[var(--text)]">{quota.limit}</span> free {featureName.toLowerCase()} this month
            </p>
          )}

          {/* CTA */}
          <button
            onClick={handleUpgrade}
            className="mt-4 w-full flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium bg-accent text-white rounded hover:bg-accent/90 transition-colors"
          >
            Upgrade to Pro
            <ArrowRight size={14} />
          </button>

          <button
            onClick={handleClose}
            className="mt-2 w-full py-2 text-xs text-muted hover:text-[var(--text)] transition-colors"
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Hook: gated action ───────────────────────────────────────────────────────

/**
 * Returns whether the upgrade modal should be shown and a handler to invoke on
 * gated action clicks.
 *
 * Usage:
 *   const { showUpgrade, upgradeProps } = useGatedAction({
 *     feature: 'marketplace_publish',
 *     featureName: 'Publish to Community',
 *     description: 'Share your specs with the community',
 *     isFree: user?.plan === 'free',
 *     onAllowed: () => setShowPublishModal(true),
 *   });
 *   <button onClick={showUpgrade}>Publish</button>
 *   <UpgradePromptModal {...upgradeProps} />
 */
export function useGatedAction({
  feature,
  featureName,
  description,
  isFree,
  onAllowed,
  onUpgrade,
}: {
  feature: string;
  featureName: string;
  description: string;
  isFree: boolean;
  onAllowed: () => void;
  onUpgrade?: () => void;
}) {
  const [open, setOpen] = useState(false);

  const trigger = useCallback(() => {
    if (!isFree) {
      onAllowed();
      return;
    }
    // Skip re-showing if dismissed in same session
    if (sessionDismissed.has(feature)) {
      // Still block the action for free users
      return;
    }
    setOpen(true);
  }, [isFree, onAllowed, feature]);

  const close = useCallback(() => setOpen(false), []);

  return {
    trigger,
    upgradeProps: {
      feature,
      featureName,
      description,
      open,
      onClose: close,
      onUpgrade,
    } satisfies UpgradePromptProps,
  };
}
