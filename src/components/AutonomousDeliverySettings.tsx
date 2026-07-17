/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';

interface DeliveryPolicy {
  id: string;
  revision: number;
  repository: { owner: string; name: string };
  baseBranch: string;
  allowedRiskLevels: Array<'low' | 'medium'>;
  requiredChecks: string[];
  reviewRules: {
    minimumApprovals: number;
    requireCodeOwnerReview: boolean;
    dismissStaleApprovals: true;
    requiredReviewers: string[];
  };
  mergeMethod: 'merge' | 'squash' | 'rebase';
  retryBudget: { maxAttempts: number; maxElapsedMinutes: number };
  deploymentAllowed: false;
  policyDigest: string;
  status: 'disabled' | 'active' | 'revoked';
  effectiveStatus: 'disabled' | 'active' | 'revoked' | 'expired';
  expiresAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

interface PolicyResponse {
  active: DeliveryPolicy | null;
  policies: DeliveryPolicy[];
}

interface DeliveryEvidence {
  id: string;
  runId: number;
  policy: { id: string; digest: string } | null;
  pullRequest: {
    number: number;
    url: string;
    headSha: string;
    baseSha: string;
    headRef: string;
    baseRef: string;
    mergeable: boolean | null;
    mergeableState: string;
  };
  freshness: { branchFresh: boolean; behindBy: number; comparisonStatus: string };
  checkSummary: {
    allRequiredPassed: boolean;
    passing: string[];
    pending: string[];
    failing: string[];
    missing: string[];
    policyAvailable: boolean;
    policyScopeMatches: boolean;
  };
  reviewSummary: {
    reviewSatisfied: boolean;
    currentApprovals: number;
    minimumApprovals: number | null;
    missingRequiredReviewers: string[];
    changesRequestedBy: string[];
    policyAvailable: boolean;
    policyScopeMatches: boolean;
  };
  providerObservedAt: string;
  payloadHash: string;
}

interface AutonomousDelivery {
  id: string;
  runId: number;
  specSlug: string;
  riskLevel: string;
  pullRequest: { number: number; baseBranch: string; branchName: string };
  currentHeadSha: string;
  status: string;
  recoveryAttempts: number;
  deadlineAt: string;
  mergedSha: string | null;
  terminalReason: string | null;
}

interface Props {
  workspaceId: string;
  connected: boolean;
  showToast: (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;
}

function newRequestId(prefix: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function defaultExpiry(): string {
  const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function shortDigest(value: string): string {
  return value.length > 24 ? `${value.slice(0, 18)}…${value.slice(-8)}` : value;
}

export default function AutonomousDeliverySettings({ workspaceId, connected, showToast }: Props) {
  const [policies, setPolicies] = useState<PolicyResponse>({ active: null, policies: [] });
  const [evidence, setEvidence] = useState<DeliveryEvidence[]>([]);
  const [deliveries, setDeliveries] = useState<AutonomousDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showDraft, setShowDraft] = useState(false);
  const [baseBranch, setBaseBranch] = useState('main');
  const [allowMediumRisk, setAllowMediumRisk] = useState(false);
  const [requiredChecks, setRequiredChecks] = useState('Backend Tests\nFrontend Tests');
  const [minimumApprovals, setMinimumApprovals] = useState(1);
  const [requiredReviewers, setRequiredReviewers] = useState('');
  const [requireCodeOwnerReview, setRequireCodeOwnerReview] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<'merge' | 'squash' | 'rebase'>('squash');
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [maxElapsedMinutes, setMaxElapsedMinutes] = useState(90);
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const [revocationReason, setRevocationReason] = useState('');
  const [runId, setRunId] = useState('');
  const [expectedHeadSha, setExpectedHeadSha] = useState('');
  const [observing, setObserving] = useState(false);

  const load = useCallback(async () => {
    if (!connected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [policyData, evidenceData, deliveryData] = await Promise.all([
        apiFetch<PolicyResponse>(`/api/workspaces/${workspaceId}/github/delivery-policies`),
        apiFetch<{ items: DeliveryEvidence[] }>(`/api/workspaces/${workspaceId}/github/delivery-evidence?limit=10`),
        apiFetch<{ items: AutonomousDelivery[] }>(`/api/workspaces/${workspaceId}/github/autonomous-deliveries?limit=10`),
      ]);
      setPolicies(policyData);
      setEvidence(evidenceData.items ?? []);
      setDeliveries(deliveryData.items ?? []);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to load autonomous delivery governance', 'error');
    } finally {
      setLoading(false);
    }
  }, [connected, showToast, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const latestDisabled = useMemo(
    () => policies.policies.find((policy) => policy.effectiveStatus === 'disabled') ?? null,
    [policies.policies],
  );

  const createPolicy = async () => {
    setSaving(true);
    try {
      const checks = splitList(requiredChecks);
      if (checks.length === 0) throw new Error('At least one required CI check is required');
      const expiry = new Date(expiresAt);
      if (Number.isNaN(expiry.getTime())) throw new Error('A valid policy expiry is required');
      await apiFetch(`/api/workspaces/${workspaceId}/github/delivery-policies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newRequestId('delivery-policy-create') },
        body: JSON.stringify({
          baseBranch,
          allowedRiskLevels: allowMediumRisk ? ['low', 'medium'] : ['low'],
          requiredChecks: checks,
          reviewRules: {
            minimumApprovals,
            requireCodeOwnerReview,
            dismissStaleApprovals: true,
            requiredReviewers: splitList(requiredReviewers),
          },
          mergeMethod,
          retryBudget: { maxAttempts, maxElapsedMinutes },
          expiresAt: expiry.toISOString(),
        }),
      });
      showToast('Disabled autonomous delivery policy drafted');
      setShowDraft(false);
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to draft policy', 'error');
    } finally {
      setSaving(false);
    }
  };

  const activatePolicy = async (policy: DeliveryPolicy) => {
    const accepted = window.confirm(
      `Enable autonomous reviewed PR delivery for ${policy.repository.owner}/${policy.repository.name}:${policy.baseBranch}?\n\n` +
      `Required checks: ${policy.requiredChecks.join(', ')}\nMinimum approvals: ${policy.reviewRules.minimumApprovals}\n` +
      'Deployment remains separately controlled and disabled by this policy.',
    );
    if (!accepted) return;
    setSaving(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/github/delivery-policies/${policy.id}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newRequestId('delivery-policy-activate') },
        body: JSON.stringify({
          expectedPolicyDigest: policy.policyDigest,
          confirmation: 'ENABLE_AUTONOMOUS_PR_DELIVERY',
        }),
      });
      showToast('Autonomous PR delivery policy enabled');
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to activate policy', 'error');
    } finally {
      setSaving(false);
    }
  };

  const revokePolicy = async (policy: DeliveryPolicy) => {
    const reason = revocationReason.trim();
    if (reason.length < 10) {
      showToast('Enter a revocation reason of at least 10 characters', 'error');
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/github/delivery-policies/${policy.id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newRequestId('delivery-policy-revoke') },
        body: JSON.stringify({ reason }),
      });
      setRevocationReason('');
      showToast('Autonomous PR delivery policy revoked');
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to revoke policy', 'error');
    } finally {
      setSaving(false);
    }
  };

  const startDelivery = async () => {
    const numericRunId = Number(runId);
    if (!Number.isSafeInteger(numericRunId) || numericRunId <= 0) {
      showToast('Enter a valid Rorca run ID', 'error');
      return;
    }
    setObserving(true);
    try {
      const result = await apiFetch<{ queued: boolean; reason: string | null }>(
        `/api/workspaces/${workspaceId}/github/autonomous-deliveries`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newRequestId('autonomous-delivery-start') },
          body: JSON.stringify({ runId: numericRunId }),
        },
      );
      showToast(result.queued ? 'Autonomous reviewed delivery queued' : `Delivery did not queue: ${result.reason ?? 'not eligible'}`, result.queued ? 'success' : 'warning');
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to queue reviewed delivery', 'error');
    } finally {
      setObserving(false);
    }
  };

  const observeEvidence = async () => {
    const numericRunId = Number(runId);
    if (!Number.isSafeInteger(numericRunId) || numericRunId <= 0) {
      showToast('Enter a valid Rorca run ID', 'error');
      return;
    }
    if (!/^[0-9a-f]{40,64}$/i.test(expectedHeadSha.trim())) {
      showToast('Enter the full expected PR head SHA', 'error');
      return;
    }
    setObserving(true);
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/github/delivery-evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: numericRunId, expectedHeadSha: expectedHeadSha.trim().toLowerCase() }),
      });
      showToast('Exact-SHA GitHub PR evidence observed');
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to observe PR evidence', 'error');
    } finally {
      setObserving(false);
    }
  };

  if (!connected) return null;
  if (loading) return <div className="flex items-center gap-2 text-xs text-muted"><Loader2 size={14} className="animate-spin" /> Loading delivery governance…</div>;

  const active = policies.active;

  return (
    <section className="border-t border-border pt-6 space-y-4" aria-labelledby="autonomous-delivery-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="autonomous-delivery-heading" className="text-sm font-semibold text-[var(--text)]">Autonomous reviewed PR delivery</h2>
          <p className="mt-1 text-xs text-muted">Standing policy for exact-SHA checks and reviews. Deployment authority is always separate.</p>
        </div>
        <button type="button" onClick={() => void load()} className="p-1.5 rounded text-muted hover:text-[var(--text)] hover:bg-bg" aria-label="Refresh delivery governance">
          <RefreshCw size={14} />
        </button>
      </div>

      {active ? (
        <div className="rounded border border-success/30 bg-success/10 p-3 space-y-3">
          <div className="flex items-center gap-2 text-success text-sm font-medium"><ShieldCheck size={16} /> Enabled for {active.repository.owner}/{active.repository.name}:{active.baseBranch}</div>
          <div className="grid grid-cols-2 gap-2 text-xs text-muted">
            <span>Risk: {active.allowedRiskLevels.join(', ')}</span>
            <span>Merge: {active.mergeMethod}</span>
            <span>Approvals: {active.reviewRules.minimumApprovals}</span>
            <span>Expires: {new Date(active.expiresAt).toLocaleString()}</span>
          </div>
          <p className="font-mono text-[10px] text-muted break-all">{active.policyDigest}</p>
          <div className="flex gap-2">
            <input
              value={revocationReason}
              onChange={(event) => setRevocationReason(event.target.value)}
              placeholder="Reason for one-way revocation"
              className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1.5 text-xs outline-none focus:border-accent"
            />
            <button type="button" disabled={saving} onClick={() => void revokePolicy(active)} className="inline-flex items-center gap-1 rounded border border-error/30 bg-error/10 px-2 py-1.5 text-xs text-error disabled:opacity-50">
              <ShieldOff size={13} /> Revoke
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded border border-border bg-bg p-3 text-xs text-muted flex items-start gap-2">
          <ShieldOff size={15} className="mt-0.5 shrink-0" />
          <span>Autonomous PR delivery is disabled. Creating a policy does not enable it.</span>
        </div>
      )}

      {latestDisabled && !active && (
        <div className="rounded border border-warning/30 bg-warning/10 p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm text-warning"><AlertTriangle size={15} /> Policy revision {latestDisabled.revision} awaits explicit activation</div>
          <p className="text-xs text-muted">{latestDisabled.requiredChecks.join(', ')} · {latestDisabled.reviewRules.minimumApprovals} approval(s) · {latestDisabled.mergeMethod}</p>
          <p title={latestDisabled.policyDigest} className="font-mono text-[10px] text-muted">{shortDigest(latestDisabled.policyDigest)}</p>
          <button type="button" disabled={saving} onClick={() => void activatePolicy(latestDisabled)} className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            Review and enable
          </button>
        </div>
      )}

      <button type="button" onClick={() => setShowDraft((value) => !value)} className="text-xs text-accent hover:underline">
        {showDraft ? 'Cancel policy draft' : 'Draft a new policy revision'}
      </button>

      {showDraft && (
        <div className="rounded border border-border p-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-muted">Base branch<input value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-[var(--text)]" /></label>
            <label className="text-xs text-muted">Merge method<select value={mergeMethod} onChange={(event) => setMergeMethod(event.target.value as typeof mergeMethod)} className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-[var(--text)]"><option value="squash">Squash</option><option value="merge">Merge commit</option><option value="rebase">Rebase</option></select></label>
            <label className="text-xs text-muted">Minimum approvals<input type="number" min={1} max={10} value={minimumApprovals} onChange={(event) => setMinimumApprovals(Number(event.target.value))} className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-[var(--text)]" /></label>
            <label className="text-xs text-muted">Expires<input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-[var(--text)]" /></label>
            <label className="text-xs text-muted">Retry attempts<input type="number" min={0} max={5} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-[var(--text)]" /></label>
            <label className="text-xs text-muted">Retry budget (minutes)<input type="number" min={1} max={1440} value={maxElapsedMinutes} onChange={(event) => setMaxElapsedMinutes(Number(event.target.value))} className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 text-[var(--text)]" /></label>
          </div>
          <label className="block text-xs text-muted">Required check names<textarea rows={3} value={requiredChecks} onChange={(event) => setRequiredChecks(event.target.value)} className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-[var(--text)]" /></label>
          <label className="block text-xs text-muted">Required reviewer logins<textarea rows={2} value={requiredReviewers} onChange={(event) => setRequiredReviewers(event.target.value)} className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-[var(--text)]" /></label>
          <label className="flex items-center gap-2 text-xs text-[var(--text)]"><input type="checkbox" checked={allowMediumRisk} onChange={(event) => setAllowMediumRisk(event.target.checked)} /> Allow medium risk (high/critical always require human approval)</label>
          <label className="flex items-center gap-2 text-xs text-[var(--text)]"><input type="checkbox" checked={requireCodeOwnerReview} onChange={(event) => setRequireCodeOwnerReview(event.target.checked)} /> Require code-owner review (automation remains blocked until provider verification exists)</label>
          <div className="rounded border border-warning/30 bg-warning/10 p-2 text-xs text-warning">This creates a disabled revision. A separate digest-bound confirmation is required to enable it. It never permits deployment.</div>
          <button type="button" disabled={saving} onClick={() => void createPolicy()} className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            {saving && <Loader2 size={13} className="animate-spin" />} Create disabled revision
          </button>
        </div>
      )}

      <div className="border-t border-border pt-4 space-y-3">
        <div>
          <h3 className="text-xs font-semibold text-[var(--text)]">Exact-SHA PR evidence</h3>
          <p className="mt-1 text-xs text-muted">Observe GitHub state for a Rorca run already bound to a PR. Observation never changes the PR.</p>
        </div>
        <div className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto_auto] gap-2">
          <input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="Run ID" aria-label="Delivery evidence run ID" className="rounded border border-border bg-bg px-2 py-1.5 text-xs" />
          <input value={expectedHeadSha} onChange={(event) => setExpectedHeadSha(event.target.value)} placeholder="Full expected PR head SHA" aria-label="Expected PR head SHA" className="rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs" />
          <button type="button" disabled={observing} onClick={() => void observeEvidence()} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-bg disabled:opacity-50">{observing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Observe</button>
          <button type="button" disabled={observing || !active} onClick={() => void startDelivery()} className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1.5 text-xs text-white disabled:opacity-50"><ShieldCheck size={13} /> Start/recheck delivery</button>
        </div>

        {deliveries.length > 0 && (
          <div className="space-y-2" aria-label="Autonomous reviewed delivery state">
            {deliveries.map((delivery) => (
              <div key={delivery.id} className="rounded border border-border bg-bg p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[var(--text)]">PR #{delivery.pullRequest.number} · run {delivery.runId}</span>
                  <span className={delivery.status === 'merged' ? 'text-success' : ['blocked', 'budget_exhausted'].includes(delivery.status) ? 'text-error' : 'text-warning'}>{delivery.status.replace(/_/g, ' ')}</span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-muted break-all">{delivery.currentHeadSha}</p>
                <p className="mt-1 text-muted">risk={delivery.riskLevel} · recovery attempts={delivery.recoveryAttempts}{delivery.mergedSha ? ` · merged ${delivery.mergedSha.slice(0, 12)}` : ''}</p>
                {delivery.terminalReason && <p className="mt-1 text-error">{delivery.terminalReason}</p>}
              </div>
            ))}
          </div>
        )}

        {evidence.length === 0 ? (
          <p className="text-xs text-muted">No PR evidence observed yet.</p>
        ) : (
          <div className="space-y-2">
            {evidence.map((item) => {
              const ready = item.checkSummary.allRequiredPassed && item.reviewSummary.reviewSatisfied && item.freshness.branchFresh && item.pullRequest.mergeable === true;
              return (
                <div key={item.id} className="rounded border border-border bg-bg p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <a href={item.pullRequest.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">PR #{item.pullRequest.number} · run {item.runId}</a>
                    <span className={ready ? 'text-success' : 'text-warning'}>{ready ? <CheckCircle2 size={14} aria-label="Evidence currently satisfies policy" /> : <AlertTriangle size={14} aria-label="Evidence has blockers" />}</span>
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-muted break-all">{item.pullRequest.headSha}</p>
                  <p className="mt-1 text-muted">checks={String(item.checkSummary.allRequiredPassed)} · reviews={String(item.reviewSummary.reviewSatisfied)} · fresh={String(item.freshness.branchFresh)} · mergeable={String(item.pullRequest.mergeable)}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
