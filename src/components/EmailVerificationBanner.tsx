/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useCallback } from 'react';
import { Mail, X, Loader2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch } from '../lib/apiFetch';

export default function EmailVerificationBanner() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resend = useCallback(async () => {
    if (!user?.email) return;
    setSending(true);
    setError(null);
    setSent(false);
    try {
      await apiFetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });
      setSent(true);
    } catch (err: any) {
      setError(err.message || 'Failed to resend');
    } finally {
      setSending(false);
    }
  }, [user?.email]);

  // Don't show if user is verified, no user, or dismissed
  const emailVerified = Boolean(user?.email_confirmed_at);
  if (!user || emailVerified || dismissed) return null;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 flex items-center gap-3 text-sm">
      <Mail size={16} className="text-amber-500 shrink-0" />
      <span className="text-amber-200 flex-1">
        Please verify your email address.
        {sent ? (
          <span className="ml-2 text-green-400">Verification email sent! Check your inbox.</span>
        ) : error ? (
          <span className="ml-2 text-red-400">{error}</span>
        ) : null}
      </span>
      <button
        onClick={resend}
        disabled={sending || sent}
        className="text-xs text-amber-400 hover:text-amber-300 underline underline-offset-2 disabled:opacity-50 whitespace-nowrap"
      >
        {sending ? <Loader2 size={12} className="inline animate-spin" /> : sent ? 'Sent' : 'Resend verification email'}
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="text-muted hover:text-[var(--text)] p-0.5"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
