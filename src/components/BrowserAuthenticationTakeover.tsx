/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { AlertTriangle, CheckCircle2, Clock3, Loader2, ShieldCheck, XCircle } from 'lucide-react';
import type { BrowserAuthenticationRequest, BrowserAuthenticationStep } from '../api/browser-session-broker';

const STEP_LABELS: Record<BrowserAuthenticationStep, string> = {
  login_expired: 'Login expired',
  consent: 'Provider consent',
  mfa: 'Multi-factor authentication',
  passkey: 'Passkey verification',
  captcha: 'CAPTCHA challenge',
  account_locked: 'Account lock',
  provider_step_up: 'Provider step-up',
  anti_automation: 'Provider anti-automation control',
};

interface BrowserAuthenticationTakeoverProps {
  request: BrowserAuthenticationRequest;
  resolving: 'complete' | 'cancel' | null;
  error: string | null;
  onComplete: () => void;
  onCancel: () => void;
}

export default function BrowserAuthenticationTakeover({
  request,
  resolving,
  error,
  onComplete,
  onCancel,
}: BrowserAuthenticationTakeoverProps) {
  const expiresAt = new Date(request.authenticationExpiresAt);
  const observedAt = new Date(request.evidence.observedAt);
  const prohibited = request.evidence.automationPolicy === 'prohibited';
  const revalidating = request.state === 'REVALIDATING';

  return (
    <section
      className="h-full overflow-y-auto bg-bg px-4 py-6 md:px-8 md:py-10"
      aria-labelledby="browser-authentication-title"
      data-testid="browser-authentication-takeover"
    >
      <div className="mx-auto max-w-3xl rounded-xl border border-warning/40 bg-panel shadow-lg">
        <div className="border-b border-border px-5 py-4 md:px-6">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-warning/10 p-2 text-warning">
              <ShieldCheck size={22} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-warning">Operator takeover required</p>
              <h2 id="browser-authentication-title" className="mt-1 text-lg font-semibold text-[var(--text)]">
                {STEP_LABELS[request.step]}
              </h2>
              <p className="mt-1 text-sm text-muted">
                Complete this step in the dedicated {request.externalProvider === 'claude' ? 'Claude' : 'ChatGPT'} browser window.
              </p>
            </div>
            {revalidating ? <Loader2 size={20} className="animate-spin text-warning" aria-label="Revalidating provider state" /> : null}
          </div>
        </div>

        <div className="space-y-5 px-5 py-5 md:px-6">
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-4" role="status" aria-live="polite">
            <div className="flex gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
              <div className="space-y-1 text-sm">
                <p className="font-medium text-[var(--text)]">Model input and browser automation are suspended.</p>
                <p className="text-muted">
                  Rorca will not enter credentials, solve a CAPTCHA, operate a passkey, bypass MFA, or circumvent provider controls.
                  Completion is accepted only after the runner observes the provider challenge cleared and the session healthy.
                </p>
              </div>
            </div>
          </div>

          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted">Provider / profile</dt>
              <dd className="mt-0.5 font-medium text-[var(--text)]">{request.externalProvider} · generation {request.profileGeneration}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Story</dt>
              <dd className="mt-0.5 font-medium text-[var(--text)]">{request.storyId}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Purpose</dt>
              <dd className="mt-0.5 break-words font-medium text-[var(--text)]">{request.purpose}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Observed origin</dt>
              <dd className="mt-0.5 break-all font-medium text-[var(--text)]">{request.evidence.currentOrigin}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Observed</dt>
              <dd className="mt-0.5 font-medium text-[var(--text)]">{observedAt.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Authentication expiry</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 font-medium text-[var(--text)]">
                <Clock3 size={14} aria-hidden="true" />
                {expiresAt.toLocaleString()}
              </dd>
            </div>
          </dl>

          {prohibited ? (
            <div className="rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error" role="alert">
              Provider policy prohibits automation for this state. The lease is being revoked and this step cannot be completed through Rorca.
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end md:px-6">
          <button
            type="button"
            onClick={onCancel}
            disabled={resolving !== null}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-bg hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resolving === 'cancel' ? <Loader2 size={16} className="animate-spin" /> : <XCircle size={16} />}
            Cancel and revoke
          </button>
          <button
            type="button"
            onClick={onComplete}
            disabled={resolving !== null || prohibited}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-[var(--accent-contrast)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resolving === 'complete' ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            Revalidate and resume once
          </button>
        </div>
      </div>
    </section>
  );
}
