/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { apiFetch } from '../../lib/apiFetch';

const STRIPE_CREDENTIAL_VALUE = /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/g;
const REDACTED_CREDENTIAL = '[credential redacted]';

export function stripeCredentialSafeText(value: unknown): string {
  return String(value ?? '').replace(STRIPE_CREDENTIAL_VALUE, REDACTED_CREDENTIAL);
}

interface StripeProviderBinding {
  bindingId: string;
  mode: 'test' | 'live';
  scope: {
    applicationId: string;
    resourceType: string;
    resourceId: string;
  };
  credentialClass: 'restricted_api_key' | 'unrestricted_api_key' | 'webhook_signing_secret';
  permissionManifest: string[];
  fingerprint: string;
  status: 'active' | 'staged' | 'quarantined' | 'revoked' | 'invalid';
  generation: number;
  lastVerifiedAt: string | null;
}

interface ProviderBindingInventoryResponse {
  items: StripeProviderBinding[];
}

interface ProviderStatusReceipt {
  status: 'active' | 'rejected' | 'unknown';
  observedAt: string;
}

interface RollbackReceipt {
  receiptId: string;
  bindingId: string;
  priorFingerprint: string;
  replacementFingerprint: string;
  failurePhase: 'TARGET_STAGE' | 'CANARY' | 'PRE_REVOCATION_VERIFICATION';
  disposition: 'ROLLED_BACK' | 'MANUAL_RECONCILIATION';
  priorBindingStatus: 'retained_active' | 'manual_reconciliation';
  replacementSecretStatus: 'quarantined';
  targetDisposition: 'prior_already_active' | 'prior_restored' | 'manual_reconciliation';
  priorProviderStatus: ProviderStatusReceipt;
  replacementProviderStatus: ProviderStatusReceipt;
  manualReconciliation: {
    reasonCode: string;
    requiredActions: string[];
  } | null;
  settledAt: string;
}

interface EmergencyRequest {
  requestId: string;
  requestType: 'RUNTIME_AUTHENTICATION_FAILURE';
  bindingId: string;
  fingerprint: string;
  mode: 'test';
  affectedResource: {
    applicationId: string;
    resourceType: string;
    resourceId: string;
  };
  permissionManifest: string[];
  evidence: {
    operation: string;
    providerHttpStatus: 401;
    observedAt: string;
  };
  state: 'AWAITING_DASHBOARD_AUTHENTICATION';
  authority: {
    canGrant: false;
    canBroadenPermissions: false;
    canCrossWorkspace: false;
    canCrossMode: false;
    canInjectSecret: false;
    requiresDashboardAuthentication: true;
  };
  requestedAt: string;
}

interface ReconciliationReceipt {
  receiptId: string;
  bindingId: string;
  priorFingerprint: string;
  replacementFingerprint: string;
  disposition: 'PROVIDER_READBACK_RESOLVED' | 'MANUAL_RECONCILIATION';
  retryAllowed: boolean;
  priorProviderStatus: ProviderStatusReceipt;
  replacementProviderStatus: ProviderStatusReceipt;
  requiredDashboardAuthentication: true;
  reconciledAt: string;
}

type CredentialIncident =
  | { kind: 'rollback'; receipt: RollbackReceipt }
  | { kind: 'emergency'; request: EmergencyRequest }
  | { kind: 'reconciliation'; receipt: ReconciliationReceipt };

interface CredentialIncidentResponse {
  items: CredentialIncident[];
}

function shortFingerprint(fingerprint: string): string {
  const safe = stripeCredentialSafeText(fingerprint);
  return safe.length > 20 ? `${safe.slice(0, 15)}…${safe.slice(-6)}` : safe;
}

function displayTime(value: string | null): string {
  if (!value) return 'Never verified';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Time unavailable' : parsed.toLocaleString();
}

function statusClasses(status: string): string {
  if (['active', 'ROLLED_BACK', 'PROVIDER_READBACK_RESOLVED'].includes(status)) {
    return 'border-success/30 bg-success/5 text-success';
  }
  if (['MANUAL_RECONCILIATION', 'AWAITING_DASHBOARD_AUTHENTICATION'].includes(status)) {
    return 'border-warning/30 bg-warning/5 text-warning';
  }
  return 'border-border bg-bg text-muted';
}

function IncidentCard({ incident }: { incident: CredentialIncident }) {
  if (incident.kind === 'emergency') {
    const { request } = incident;
    return (
      <article className="rounded-lg border border-warning/30 bg-warning/5 p-4" data-testid="credential-emergency">
        <div className="flex items-start gap-3">
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold text-[var(--text)]">Runtime authentication failure</h4>
              <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${statusClasses(request.state)}`}>
                Awaiting Dashboard authentication
              </span>
            </div>
            <p className="text-xs text-muted">
              {stripeCredentialSafeText(request.affectedResource.applicationId)} ·{' '}
              {stripeCredentialSafeText(request.affectedResource.resourceType)} /{' '}
              {stripeCredentialSafeText(request.affectedResource.resourceId)}
            </p>
            <dl className="grid gap-2 text-xs sm:grid-cols-3">
              <div><dt className="text-muted">Binding</dt><dd className="font-mono text-[var(--text)]">{shortFingerprint(request.fingerprint)}</dd></div>
              <div><dt className="text-muted">Operation</dt><dd className="text-[var(--text)]">{stripeCredentialSafeText(request.evidence.operation)}</dd></div>
              <div><dt className="text-muted">Observed</dt><dd className="text-[var(--text)]">{displayTime(request.evidence.observedAt)}</dd></div>
            </dl>
            <div className="rounded border border-border bg-bg px-3 py-2 text-xs text-[var(--text)]">
              <strong>No emergency authority was granted.</strong>{' '}
              Reauthenticate in the Stripe Dashboard and create a separately approved rotation intent.
              Permissions, workspace, mode, and target remain fixed to this binding.
            </div>
          </div>
        </div>
      </article>
    );
  }

  if (incident.kind === 'rollback') {
    const { receipt } = incident;
    const automatic = receipt.disposition === 'ROLLED_BACK';
    return (
      <article className={`rounded-lg border p-4 ${automatic ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5'}`} data-testid="credential-rollback">
        <div className="flex items-start gap-3">
          <RotateCcw size={18} className={`mt-0.5 shrink-0 ${automatic ? 'text-success' : 'text-warning'}`} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold text-[var(--text)]">
                {automatic ? 'Prior binding restored' : 'Rollback requires reconciliation'}
              </h4>
              <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${statusClasses(receipt.disposition)}`}>
                {receipt.disposition === 'ROLLED_BACK' ? 'Rolled back' : 'Retry blocked'}
              </span>
            </div>
            <p className="text-xs text-muted">
              {receipt.failurePhase.replaceAll('_', ' ').toLowerCase()} failure · replacement quarantined · old binding{' '}
              {receipt.priorBindingStatus === 'retained_active' ? 'retained active' : 'requires verification'}
            </p>
            <dl className="grid gap-2 text-xs sm:grid-cols-3">
              <div><dt className="text-muted">Prior</dt><dd className="font-mono text-[var(--text)]">{shortFingerprint(receipt.priorFingerprint)}</dd></div>
              <div><dt className="text-muted">Replacement</dt><dd className="font-mono text-[var(--text)]">{shortFingerprint(receipt.replacementFingerprint)}</dd></div>
              <div><dt className="text-muted">Receipt</dt><dd className="font-mono text-[var(--text)]">{stripeCredentialSafeText(receipt.receiptId)}</dd></div>
            </dl>
            {!automatic && (
              <p className="rounded border border-warning/30 bg-bg px-3 py-2 text-xs text-[var(--text)]">
                Provider or target status is unknown. Retry remains disabled until exact fingerprints are manually reconciled and Dashboard authentication is completed.
              </p>
            )}
          </div>
        </div>
      </article>
    );
  }

  const { receipt } = incident;
  const manual = receipt.disposition === 'MANUAL_RECONCILIATION';
  return (
    <article className={`rounded-lg border p-4 ${manual ? 'border-warning/30 bg-warning/5' : 'border-success/30 bg-success/5'}`} data-testid="credential-reconciliation">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className={`mt-0.5 shrink-0 ${manual ? 'text-warning' : 'text-success'}`} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-[var(--text)]">Provider key-status reconciliation</h4>
            <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${statusClasses(receipt.disposition)}`}>
              {manual ? 'Manual reconciliation' : 'Readback resolved'}
            </span>
          </div>
          <p className="text-xs text-muted">
            Old key: {receipt.priorProviderStatus.status} · replacement: {receipt.replacementProviderStatus.status} · retry {receipt.retryAllowed ? 'permitted by readback' : 'blocked'}
          </p>
          {manual && (
            <p className="rounded border border-warning/30 bg-bg px-3 py-2 text-xs text-[var(--text)]">
              No retry or authority change is available until an operator reconciles both exact fingerprints in the Stripe Dashboard.
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

export function StripeCredentialAuthoritySection() {
  const { workspaceId } = useWorkspace();
  const [bindings, setBindings] = useState<StripeProviderBinding[]>([]);
  const [incidents, setIncidents] = useState<CredentialIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError('');
    try {
      const workspace = encodeURIComponent(workspaceId);
      const [inventory, incidentResponse] = await Promise.all([
        apiFetch<ProviderBindingInventoryResponse>(`/api/workspaces/${workspace}/provider-bindings?limit=250`),
        apiFetch<CredentialIncidentResponse>(`/api/workspaces/${workspace}/provider-bindings/credential-incidents?limit=100`),
      ]);
      setBindings(Array.isArray(inventory.items) ? inventory.items : []);
      setIncidents(Array.isArray(incidentResponse.items) ? incidentResponse.items : []);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Request failed';
      setError(stripeCredentialSafeText(message) || 'Failed to load Stripe credential authority state');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summary = useMemo(() => ({
    active: bindings.filter((binding) => binding.status === 'active').length,
    emergencies: incidents.filter((incident) => incident.kind === 'emergency').length,
    manual: incidents.filter((incident) =>
      (incident.kind === 'rollback' && incident.receipt.disposition === 'MANUAL_RECONCILIATION')
      || (incident.kind === 'reconciliation' && incident.receipt.disposition === 'MANUAL_RECONCILIATION')).length,
  }), [bindings, incidents]);

  return (
    <section aria-labelledby="stripe-credential-authority-heading" className="rounded-xl border border-border bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} className="mt-0.5 shrink-0 text-accent" />
          <div>
            <h2 id="stripe-credential-authority-heading" className="text-base font-semibold text-[var(--text)]">
              Stripe credential authority
            </h2>
            <p className="mt-1 max-w-3xl text-xs text-muted">
              Secret-free binding inventory, rollback receipts, runtime authentication incidents, and manual-reconciliation blockers. Credential values never enter this page or its API.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded border border-border bg-bg px-3 py-1.5 text-xs text-[var(--text)] transition-colors hover:border-accent disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-bg p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted">Active bindings</p>
          <p className="mt-1 text-xl font-semibold text-[var(--text)]">{summary.active}</p>
        </div>
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted">Emergency requests</p>
          <p className="mt-1 text-xl font-semibold text-warning">{summary.emergencies}</p>
        </div>
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted">Manual blockers</p>
          <p className="mt-1 text-xl font-semibold text-warning">{summary.manual}</p>
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-xs text-muted">
        <KeyRound size={15} className="mt-0.5 shrink-0 text-muted" />
        <span>Live-mode rotation is disabled until separately authorized qualification evidence exists. Test and live bindings never fall back across modes.</span>
      </div>

      {error && (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <div>
          <h3 className="mb-3 text-sm font-semibold text-[var(--text)]">Bound credentials</h3>
          {loading && bindings.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg p-4 text-xs text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading secret-free inventory…
            </div>
          ) : bindings.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted">No Stripe credential bindings are recorded for this workspace.</p>
          ) : (
            <div className="space-y-2">
              {bindings.map((binding) => (
                <article key={binding.bindingId} className="rounded-lg border border-border bg-bg p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {binding.status === 'active' ? <CheckCircle2 size={15} className="text-success" /> : <AlertTriangle size={15} className="text-warning" />}
                      <span className="text-sm font-medium text-[var(--text)]">{stripeCredentialSafeText(binding.scope.applicationId)}</span>
                    </div>
                    <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${statusClasses(binding.status)}`}>
                      {binding.mode} · {binding.status}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    {stripeCredentialSafeText(binding.credentialClass.replaceAll('_', ' '))} · generation {binding.generation} · {displayTime(binding.lastVerifiedAt)}
                  </p>
                  <p className="mt-1 font-mono text-xs text-[var(--text)]">{shortFingerprint(binding.fingerprint)}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {binding.permissionManifest.map((permission) => (
                      <span key={permission} className="rounded border border-border bg-panel px-1.5 py-0.5 text-[10px] text-muted">
                        {stripeCredentialSafeText(permission)}
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-3 text-sm font-semibold text-[var(--text)]">Failure and emergency evidence</h3>
          {loading && incidents.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg p-4 text-xs text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading incident receipts…
            </div>
          ) : incidents.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted">No rollback, emergency, or reconciliation evidence is recorded.</p>
          ) : (
            <div className="space-y-3">
              {incidents.map((incident) => (
                <IncidentCard
                  key={incident.kind === 'emergency' ? incident.request.requestId : incident.receipt.receiptId}
                  incident={incident}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
