/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle, Ban, CircleStop, FileCheck2, LockKeyhole, Pause, RefreshCw, ShieldCheck, Wifi, WifiOff, X,
} from 'lucide-react';
import {
  getBountyFeaturePolicy, getBountyQualificationStatus, getMissionAuthority, getSessionEvents, loadMissionControl, mutateMissionControl,
  type BountyQualificationStatus, type DraftProjection, type HoldProjection, type MissionControlIdentity,
  type MissionControlProjection, type MissionControlReceipt,
} from '../api/bountyMissionControl';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useFocusTrap } from '../hooks/useFocusTrap';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PREVIEW_TTL_MS = 60_000;
type GovernedAction = 'pause' | 'stop' | 'kill' | 'hold-release' | 'approve-readiness' | 'reject';
type OperationPhase = 'requested' | 'committed' | 'reconciled';

interface ApprovalPreview {
  action: GovernedAction;
  label: string;
  expiresAt: string;
  epoch: number;
  contractHash: string;
  scopeHash: string;
  hold?: HoldProjection;
  draft?: DraftProjection;
}

interface OperationState {
  phase: OperationPhase;
  action: GovernedAction;
  receipt?: MissionControlReceipt;
  message?: string;
}

const compactHash = (value: string): string => value.length > 24 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value;
const date = (value: string | null): string => value ? new Date(value).toLocaleString() : '—';
const stateLabel = (value: string): string => value.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase());

function PanelCard({ title, count, children, ariaLabel }: { title: string; count?: number; children: ReactNode; ariaLabel?: string }) {
  return (
    <section className="rounded-xl border border-border bg-panel p-4 min-w-0" aria-label={ariaLabel ?? title}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">{title}</h2>
        {count !== undefined && <span className="rounded-full bg-surface-200 px-2 py-0.5 text-xs text-muted">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="break-all font-mono text-xs text-[var(--text)]" title={value}>{value || 'Unavailable'}</dd>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-sm text-muted">{children}</p>;
}

function ApprovalDialog({ preview, pending, staleError, onClose, onConfirm }: {
  preview: ApprovalPreview;
  pending: boolean;
  staleError: string | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const headingId = 'mission-approval-heading';
  const dialogRef = useFocusTrap<HTMLDivElement>(true, undefined, {
    onEscape: pending ? undefined : onClose,
  });

  const hashes = [
    ['Contract hash', preview.contractHash], ['Scope hash', preview.scopeHash],
    ...(preview.draft ? [
      ['Bundle hash', preview.draft.bundleHash], ['Markdown hash', preview.draft.markdownHash], ['JSON hash', preview.draft.jsonHash],
    ] : []),
  ];

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" role="presentation">
      <div ref={dialogRef} className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-border bg-panel p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-warning">Exact human approval</p>
            <h2 id={headingId} className="mt-1 text-lg font-semibold text-[var(--text)]">Review {preview.label}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={pending} className="rounded p-2 text-muted hover:bg-surface-200 disabled:opacity-50" aria-label="Close approval dialog">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <dl className="mt-5 space-y-3 rounded-lg bg-surface-200 p-4" aria-label="Approval target">
          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3"><dt className="text-xs text-muted">Action</dt><dd className="text-sm font-semibold text-[var(--text)]">{preview.label}</dd></div>
          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3"><dt className="text-xs text-muted">Authority epoch</dt><dd className="font-mono text-xs text-[var(--text)]">{preview.epoch}</dd></div>
          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3"><dt className="text-xs text-muted">Preview expires</dt><dd className="text-xs text-[var(--text)]">{date(preview.expiresAt)}</dd></div>
          {hashes.map(([label, value]) => <HashRow key={label} label={label} value={value} />)}
        </dl>

        <label className="mt-4 block text-sm font-medium text-[var(--text)]" htmlFor="mission-control-reason">Operator reason</label>
        <textarea
          id="mission-control-reason" autoFocus value={reason} onChange={(event) => setReason(event.target.value)}
          className="mt-2 min-h-24 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          maxLength={512} disabled={pending || Boolean(staleError)}
        />
        {staleError && <p role="alert" className="mt-3 rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error">{staleError}</p>}
        <p className="mt-3 text-xs text-muted">This approval is local and exact. It cannot submit a finding or widen mission capabilities.</p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} disabled={pending} className="min-h-11 rounded-lg border border-border px-4 text-sm text-[var(--text)] hover:bg-surface-200 disabled:opacity-50">Cancel</button>
          <button
            type="button" onClick={() => onConfirm(reason.trim())} disabled={pending || Boolean(staleError) || !reason.trim()}
            className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Verifying authority…' : `Confirm ${preview.label}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function OperationProgress({ operation }: { operation: OperationState }) {
  const phases: OperationPhase[] = ['requested', 'committed', 'reconciled'];
  const current = phases.indexOf(operation.phase);
  return (
    <section className="rounded-xl border border-accent/40 bg-panel p-4" aria-label="Control operation state" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--text)]">{stateLabel(operation.action)} control</h2>
        {operation.receipt?.replayed && <span className="rounded-full bg-warning/10 px-2 py-1 text-xs font-medium text-warning">Idempotent replay</span>}
      </div>
      <ol className="mt-3 grid grid-cols-3 gap-2" aria-label="Requested, committed, and reconciled states">
        {phases.map((phase, index) => (
          <li key={phase} aria-current={phase === operation.phase ? 'step' : undefined} className={`rounded-lg border px-2 py-2 text-center text-xs font-medium ${index <= current ? 'border-accent bg-accent/10 text-[var(--text)]' : 'border-border text-muted'}`}>
            {stateLabel(phase)}
          </li>
        ))}
      </ol>
      {operation.message && <p className="mt-2 text-xs text-muted">{operation.message}</p>}
    </section>
  );
}

function FeatureState({ error, qualification, onRetry }: { error?: string; qualification?: BountyQualificationStatus; onRetry?: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg rounded-xl border border-border bg-panel p-8 text-center" role={error ? 'alert' : 'status'}>
        <LockKeyhole className="mx-auto text-muted" size={32} aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold text-[var(--text)]">Mission Control is unavailable</h1>
        <p className="mt-2 text-sm text-muted">{error ?? 'The operator-owned bounty policy is disabled. Repository content cannot enable this panel.'}</p>
        {qualification && (
          <section className="mt-5 rounded-lg border border-warning/30 bg-warning/10 p-4 text-left" aria-label="Bounty qualification status">
            <p className="text-xs font-semibold uppercase tracking-wide text-warning">Qualification required</p>
            <p className="mt-2 text-sm text-[var(--text)]">{qualification.fixturePassedSuiteCount}/{qualification.requiredSuiteCount} hermetic fixture suites passed · {qualification.requiredControlProofCount} safety proofs.</p>
            <p className="mt-2 text-xs text-muted">{qualification.reason} Release enablement remains unavailable.</p>
          </section>
        )}
        {onRetry && <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded-lg border border-border px-4 text-sm text-[var(--text)] hover:bg-surface-200">Retry policy check</button>}
      </div>
    </div>
  );
}

export default function MissionControlPanel() {
  const { workspaceId } = useWorkspace();
  const [gate, setGate] = useState<'loading' | 'enabled' | 'disabled' | 'error'>('loading');
  const [gateError, setGateError] = useState<string>();
  const [qualification, setQualification] = useState<BountyQualificationStatus>();
  const [programId, setProgramId] = useState('');
  const [missionId, setMissionId] = useState('');
  const [identity, setIdentity] = useState<MissionControlIdentity | null>(null);
  const [data, setData] = useState<MissionControlProjection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<'connected' | 'offline' | 'reconnecting'>('connected');
  const [preview, setPreview] = useState<ApprovalPreview | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [staleError, setStaleError] = useState<string | null>(null);
  const [operation, setOperation] = useState<OperationState | null>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const checkPolicy = useCallback(async () => {
    setGate('loading'); setGateError(undefined);
    try {
      const [policy, qualificationStatus] = await Promise.all([
        getBountyFeaturePolicy(), getBountyQualificationStatus(),
      ]);
      setQualification(qualificationStatus);
      setGate(policy.enabled ? 'enabled' : 'disabled');
    } catch (caught) {
      setGate('error'); setGateError(caught instanceof Error ? caught.message : 'Policy check failed');
    }
  }, []);
  useEffect(() => { void checkPolicy(); }, [checkPolicy]);

  const refresh = useCallback(async (target = identityRef.current) => {
    if (!target) return;
    setLoading(true); setError(null);
    try {
      const next = await loadMissionControl(target);
      setData(next); setConnection('connected');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Mission projection failed to load');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!identity) return;
    const stream = async () => {
      if (!navigator.onLine) { setConnection('offline'); return; }
      try {
        const after = data?.sessions.nextCursor ?? 0;
        const next = await getSessionEvents(identity, after);
        setData((current) => {
          if (!current) return current;
          const existing = new Set(current.sessions.events.map((event) => event.id));
          return { ...current, sessions: { ...next, events: [...current.sessions.events, ...next.events.filter((event) => !existing.has(event.id))] } };
        });
        setConnection('connected');
      } catch { setConnection('reconnecting'); }
    };
    const offline = () => setConnection('offline');
    const online = () => { setConnection('reconnecting'); void stream(); };
    window.addEventListener('offline', offline); window.addEventListener('online', online);
    const timer = window.setInterval(() => void stream(), 5_000);
    return () => { window.clearInterval(timer); window.removeEventListener('offline', offline); window.removeEventListener('online', online); };
  }, [data?.sessions.nextCursor, identity]);

  const loadIdentity = (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !UUID.test(programId) || !UUID.test(missionId)) return;
    const target = { workspaceId, programId: programId.trim(), missionId: missionId.trim() };
    setIdentity(target); identityRef.current = target; setData(null); setOperation(null);
    void refresh(target);
  };

  const openPreview = (action: GovernedAction, options: { hold?: HoldProjection; draft?: DraftProjection } = {}) => {
    if (!data) return;
    const labels: Record<GovernedAction, string> = {
      pause: 'Pause mission', stop: 'Stop mission', kill: 'Emergency kill', 'hold-release': 'Resolve hold',
      'approve-readiness': 'Approve local readiness', reject: 'Reject local draft',
    };
    setStaleError(null);
    setPreview({ action, label: labels[action], expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(), epoch: data.mission.epoch, contractHash: data.mission.contractHash, scopeHash: data.mission.scopeHash, ...options });
    setOperation({ action, phase: 'requested', message: 'Approval preview requested; no Controller mutation has been committed.' });
  };

  const confirmPreview = async (reason: string) => {
    if (!preview || !identity) return;
    setApprovalPending(true); setStaleError(null);
    try {
      if (Date.parse(preview.expiresAt) <= Date.now()) throw new Error('Preview expired. Close this dialog and request a fresh approval preview.');
      const current = await getMissionAuthority(identity);
      const currentExpiry = Date.parse(current.scopeExpiresAt);
      const stale = current.epoch !== preview.epoch
        || current.contractHash !== preview.contractHash || !SHA256.test(current.contractHash)
        || current.scopeHash !== preview.scopeHash || !SHA256.test(current.scopeHash)
        || !Number.isFinite(currentExpiry) || currentExpiry <= Date.now();
      // Draft hashes are not part of mission authority, so re-read the redacted draft projection before review commit.
      const latestDraft = preview.draft ? (await loadMissionControl(identity)).drafts.find((draft) => draft.id === preview.draft?.id) : undefined;
      const draftStale = Boolean(preview.draft && (!latestDraft
        || latestDraft.bundleHash !== preview.draft.bundleHash
        || latestDraft.markdownHash !== preview.draft.markdownHash
        || latestDraft.jsonHash !== preview.draft.jsonHash));
      if (stale || draftStale) throw new Error('Preview is stale. Mission authority or the exact review target changed; request a fresh preview.');
      const receipt = await mutateMissionControl(identity, preview.action, { expectedEpoch: preview.epoch, reason, holdId: preview.hold?.id, draftId: preview.draft?.id });
      setOperation({ action: preview.action, phase: 'committed', receipt, message: 'The Controller receipt is durable; the UI is reconciling its projection.' });
      setPreview(null);
      try {
        const reconciled = await loadMissionControl(identity);
        setData(reconciled); setConnection('connected');
        setOperation({ action: preview.action, phase: 'reconciled', receipt, message: 'Mission projections reconciled with the committed Controller receipt.' });
      } catch {
        setOperation({ action: preview.action, phase: 'committed', receipt, message: 'Committed successfully; projection reconciliation is pending. Use Refresh safely.' });
        setConnection('reconnecting');
      }
    } catch (caught) {
      setStaleError(caught instanceof Error ? caught.message : 'Approval failed closed');
    } finally { setApprovalPending(false); }
  };

  const spentMicrousd = useMemo(() => data?.telemetry.reduce((sum, item) => sum + item.costMicrousd, 0) ?? 0, [data]);
  const scopeExpiry = data ? Date.parse(data.mission.scopeExpiresAt) : Number.NaN;
  const actionDisabled = !data || loading || approvalPending
    || data.mission.state === 'stopped' || data.mission.state === 'killed'
    || !SHA256.test(data.mission.contractHash) || !SHA256.test(data.mission.scopeHash)
    || !Number.isFinite(scopeExpiry) || scopeExpiry <= Date.now();

  if (gate === 'loading') return <div className="flex h-full items-center justify-center text-sm text-muted" role="status" aria-label="Checking Mission Control policy">Checking operator policy…</div>;
  if (gate === 'disabled') return <FeatureState qualification={qualification} />;
  if (gate === 'error') return <FeatureState error={gateError} onRetry={() => void checkPolicy()} />;
  if (!workspaceId) return <FeatureState error="Select a workspace before opening an exact mission projection." />;

  return (
    <main className="h-full overflow-y-auto bg-bg p-3 sm:p-5 lg:p-6" aria-labelledby="mission-control-title">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="flex items-center gap-2 text-accent"><ShieldCheck size={18} aria-hidden="true" /><span className="text-xs font-semibold uppercase tracking-wide">Governed bounty</span></div>
            <h1 id="mission-control-title" className="mt-1 text-2xl font-semibold tracking-tight text-[var(--text)]">Mission Control</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted">Redacted, local operator projections. Workers cannot use this surface and no external submission action exists.</p>
          </div>
          <form onSubmit={loadIdentity} className="grid gap-2 rounded-xl border border-border bg-panel p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" aria-label="Open exact mission">
            <label className="text-xs text-muted">Program ID<input aria-label="Program ID" value={programId} onChange={(event) => setProgramId(event.target.value)} placeholder="UUID" className="mt-1 min-h-11 w-full rounded-lg border border-border bg-bg px-3 font-mono text-xs text-[var(--text)]" /></label>
            <label className="text-xs text-muted">Mission ID<input aria-label="Mission ID" value={missionId} onChange={(event) => setMissionId(event.target.value)} placeholder="UUID" className="mt-1 min-h-11 w-full rounded-lg border border-border bg-bg px-3 font-mono text-xs text-[var(--text)]" /></label>
            <button type="submit" disabled={!UUID.test(programId) || !UUID.test(missionId) || loading} className="min-h-11 self-end rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">{loading ? 'Loading…' : 'Open mission'}</button>
          </form>
        </header>

        {!identity && <PanelCard title="Open an exact mission"><Empty>Enter the admitted program and mission UUIDs. Mission discovery is intentionally unavailable.</Empty></PanelCard>}
        {identity && loading && !data && <div className="rounded-xl border border-border bg-panel p-10 text-center text-sm text-muted" role="status" aria-label="Loading Mission Control">Loading redacted mission projections…</div>}
        {identity && error && !data && <div className="rounded-xl border border-error/30 bg-panel p-6" role="alert"><h2 className="font-semibold text-[var(--text)]">Mission Control could not load</h2><p className="mt-2 text-sm text-muted">{error}</p><button type="button" onClick={() => void refresh()} className="mt-4 min-h-11 rounded-lg border border-border px-4 text-sm text-[var(--text)] hover:bg-surface-200">Retry connection</button></div>}

        {data && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3">
              <div className="min-w-0"><p className="truncate text-base font-semibold text-[var(--text)]">{data.mission.title}</p><p className="text-xs text-muted">{data.mission.programName} · revision {data.mission.programRevision} · epoch {data.mission.epoch}</p></div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-surface-200 px-3 py-1 text-xs font-medium text-[var(--text)]">{stateLabel(data.mission.state)}</span>
                <span className={`flex items-center gap-1 rounded-full px-3 py-1 text-xs ${connection === 'connected' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`} role="status" aria-label={`Session stream ${connection}`}>
                  {connection === 'connected' ? <Wifi size={13} aria-hidden="true" /> : <WifiOff size={13} aria-hidden="true" />}{stateLabel(connection)}
                </span>
                <button type="button" onClick={() => void refresh()} disabled={loading} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm text-[var(--text)] hover:bg-surface-200 disabled:opacity-50"><RefreshCw size={14} aria-hidden="true" />Refresh</button>
              </div>
            </div>

            {operation && <OperationProgress operation={operation} />}
            {error && <p role="alert" className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">Refresh failed: {error}. The last redacted projection remains visible.</p>}

            <section className="rounded-xl border border-border bg-panel p-4" aria-label="Stop controls">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div><h2 className="text-sm font-semibold text-[var(--text)]">Mission stop controls</h2><p className="text-xs text-muted">Every action requires a fresh exact approval preview and advances the authority epoch.</p></div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <button type="button" onClick={() => openPreview('pause')} disabled={actionDisabled || data.mission.state !== 'active'} className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-4 text-sm text-[var(--text)] hover:bg-surface-200 disabled:opacity-50"><Pause size={15} aria-hidden="true" />Pause</button>
                  <button type="button" onClick={() => openPreview('stop')} disabled={actionDisabled || !['active','paused','held'].includes(data.mission.state)} className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-warning/50 px-4 text-sm text-warning hover:bg-warning/10 disabled:opacity-50"><CircleStop size={15} aria-hidden="true" />Stop</button>
                  <button type="button" onClick={() => openPreview('kill')} disabled={actionDisabled || !['active','paused','held'].includes(data.mission.state)} className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-error/50 px-4 text-sm text-error hover:bg-error/10 disabled:opacity-50"><Ban size={15} aria-hidden="true" />Emergency kill</button>
                </div>
              </div>
            </section>

            <div data-testid="mission-control-responsive-grid" className="grid grid-cols-1 gap-4 xl:grid-cols-12">
              <div className="space-y-4 xl:col-span-5">
                <PanelCard title="Program & mission authority">
                  <dl className="space-y-3"><HashRow label="Contract hash" value={data.mission.contractHash} /><HashRow label="Scope hash" value={data.mission.scopeHash} />
                    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3"><dt className="text-xs text-muted">Scope expiry</dt><dd className="text-xs text-[var(--text)]">{date(data.mission.scopeExpiresAt)}</dd></div>
                  </dl>
                </PanelCard>
                <PanelCard title="Budget">
                  <div className="grid grid-cols-2 gap-3"><div className="rounded-lg bg-surface-200 p-3"><p className="text-xs text-muted">Observed spend</p><p className="mt-1 text-lg font-semibold text-[var(--text)]">${(spentMicrousd / 1_000_000).toFixed(2)}</p></div><div className="rounded-lg bg-surface-200 p-3"><p className="text-xs text-muted">Mission limit</p><p className="mt-1 text-lg font-semibold text-[var(--text)]">{data.mission.budgetLimitCents === null ? 'Not set' : `$${(data.mission.budgetLimitCents / 100).toFixed(2)}`}</p></div></div>
                  <p className="mt-2 text-xs text-muted">{data.mission.budgetRevision === null ? 'No budget revision' : `Budget revision ${data.mission.budgetRevision}`} · {data.telemetry.reduce((sum, item) => sum + item.requests, 0)} requests</p>
                </PanelCard>
                <PanelCard title="Approvals">
                  <p className="text-sm text-[var(--text)]">Every Controller action opens a short-lived exact approval target before mutation.</p>
                  <p className="mt-2 text-xs text-muted">{operation
                    ? `${stateLabel(operation.action)} is ${operation.phase}${operation.receipt?.replayed ? ' (replayed receipt)' : ''}.`
                    : 'No approval preview is currently requested.'}</p>
                </PanelCard>
                <PanelCard title="Work packages" count={data.work.length}>{data.work.length === 0 ? <Empty>No packages released.</Empty> : <ul className="space-y-2">{data.work.map((item) => <li key={item.id} className="rounded-lg bg-surface-200 p-3"><div className="flex justify-between gap-3"><span className="text-sm font-medium text-[var(--text)]">Package {item.releaseSequence}</span><span className="text-xs text-muted">{stateLabel(item.status)}</span></div><p className="mt-2 truncate font-mono text-xs text-muted" title={item.packageHash}>{compactHash(item.packageHash)}</p></li>)}</ul>}</PanelCard>
              </div>

              <div className="space-y-4 xl:col-span-7">
                <PanelCard title="Redacted session stream" count={data.sessions.events.length} ariaLabel="Redacted session stream">
                  {data.sessions.events.length === 0 ? <Empty>No redacted session events.</Empty> : <ol className="max-h-80 space-y-2 overflow-y-auto" aria-live="polite">{data.sessions.events.map((event) => <li key={event.id} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[5rem_minmax(0,1fr)_auto]"><span className="font-mono text-xs text-muted">#{event.cursor}</span><div className="min-w-0"><p className="truncate text-sm font-medium text-[var(--text)]">{event.eventType}</p><p className="truncate text-xs text-muted">{event.sourceRole} · session {event.sessionId}</p><p className="truncate font-mono text-xs text-muted" title={event.sourceHash}>{compactHash(event.sourceHash)}</p></div><time className="text-xs text-muted">{date(event.occurredAt)}</time></li>)}</ol>}
                  <p className="mt-3 flex items-center gap-1 text-xs text-muted"><ShieldCheck size={13} aria-hidden="true" />Payload bodies and credentials are never rendered.</p>
                </PanelCard>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <PanelCard title="Redacted evidence" count={data.evidence.length}>{data.evidence.length === 0 ? <Empty>No admitted evidence.</Empty> : <ul className="space-y-2">{data.evidence.map((item) => <li key={item.id} className="rounded-lg bg-surface-200 p-3"><p className="truncate text-sm text-[var(--text)]">{item.evidenceIdentity}</p><p className="mt-1 truncate font-mono text-xs text-muted" title={item.digest}>{compactHash(item.digest)}</p><p className="mt-1 text-xs text-muted">Epoch {item.authorityEpoch}</p></li>)}</ul>}</PanelCard>
                  <PanelCard title="Findings" count={data.findings.length}>{data.findings.length === 0 ? <Empty>No admitted findings.</Empty> : <ul className="space-y-2">{data.findings.map((item) => <li key={item.id} className="rounded-lg bg-surface-200 p-3"><div className="flex justify-between gap-2"><p className="truncate text-sm text-[var(--text)]">{item.findingIdentity}</p><span className="text-xs text-muted">{stateLabel(item.status)}</span></div><p className="mt-1 text-xs text-muted">Authority epoch {item.authorityEpoch}</p></li>)}</ul>}</PanelCard>
                </div>

                <PanelCard title="Holds" count={data.holds.length}>{data.holds.length === 0 ? <Empty>No mission holds.</Empty> : <ul className="space-y-2">{data.holds.map((hold) => <li key={hold.id} className="flex flex-col gap-3 rounded-lg bg-surface-200 p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm text-[var(--text)]">{hold.reason}</p><p className="mt-1 text-xs text-muted">{hold.releasedAt ? `Reconciled ${date(hold.releasedAt)}` : `Committed hold · ${date(hold.createdAt)}`}</p></div>{!hold.releasedAt && <button type="button" onClick={() => openPreview('hold-release', { hold })} disabled={actionDisabled || data.mission.state !== 'held'} className="min-h-11 rounded-lg border border-border px-3 text-sm text-[var(--text)] hover:bg-panel disabled:opacity-50">Resolve hold</button>}</li>)}</ul>}</PanelCard>

                <PanelCard title="Local draft review" count={data.drafts.length}>{data.drafts.length === 0 ? <Empty>No local report drafts.</Empty> : <ul className="space-y-3">{data.drafts.map((draft) => <li key={draft.id} className="rounded-lg border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-[var(--text)]">Draft revision {draft.revision}</p><span className="text-xs text-muted">{stateLabel(draft.releaseStatus)}</span></div><dl className="mt-3 space-y-2"><HashRow label="Bundle hash" value={draft.bundleHash} /><HashRow label="Markdown hash" value={draft.markdownHash} /><HashRow label="JSON hash" value={draft.jsonHash} /></dl><div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"><button type="button" onClick={() => openPreview('reject', { draft })} disabled={actionDisabled} className="min-h-11 rounded-lg border border-border px-3 text-sm text-[var(--text)] hover:bg-surface-200 disabled:opacity-50">Reject local draft</button><button type="button" onClick={() => openPreview('approve-readiness', { draft })} disabled={actionDisabled} className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"><FileCheck2 size={15} aria-hidden="true" />Approve readiness</button></div></li>)}</ul>}</PanelCard>
              </div>
            </div>

            <section className="rounded-xl border border-border bg-surface-200 p-4" aria-label="Safety exclusions"><div className="flex gap-3"><AlertTriangle className="shrink-0 text-warning" size={18} aria-hidden="true" /><div><h2 className="text-sm font-semibold text-[var(--text)]">Deliberate safety boundary</h2><p className="mt-1 text-xs text-muted">This panel has no provider submission, generic target tool, scheduling, account creation, or capability-widening control. Draft approval records local readiness only.</p></div></div></section>
          </>
        )}
      </div>
      {preview && <ApprovalDialog preview={preview} pending={approvalPending} staleError={staleError} onClose={() => { if (!approvalPending) { setPreview(null); setStaleError(null); } }} onConfirm={(reason) => void confirmPreview(reason)} />}
    </main>
  );
}
