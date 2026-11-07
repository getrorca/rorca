/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  Inbox,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  EXECUTION_AUTHORITY_EVIDENCE_KINDS,
  authorityUiErrorMessage,
  getAuthorityRequestDetail,
  getAuthorityRunState,
  getExecutionAuthorityProfile,
  listAuthorityRequests,
  mutateAuthorityRequest,
  transitionExecutionAuthorityProfile,
  type AuthorityAction,
  type AuthorityRequestDetailProjection,
  type AuthorityRequestProjection,
  type AuthorityRunStateProjection,
  type ExecutionAuthorityEvidenceKind,
  type ExecutionAuthorityProfileProjection,
} from '../api/executionAuthority';
import AppHeader from '../components/AppHeader';
import SlideOver from '../components/SlideOver';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useFocusTrap } from '../hooks/useFocusTrap';

type InboxState = 'loading' | 'ready' | 'error';
type RequestVisualState = 'active' | 'stale' | 'denied' | 'resumed' | 'closed';

interface ConfirmationIntent {
  action: AuthorityAction;
  requestId: string;
  requestDigest: string;
}

const REQUEST_STATE_LABELS: Record<RequestVisualState, string> = {
  active: 'Active',
  stale: 'Stale',
  denied: 'Denied',
  resumed: 'Resumed',
  closed: 'Closed',
};
const REQUEST_STATE_CLASSES: Record<RequestVisualState, string> = {
  active: 'border-accent/30 bg-accent/10 text-accent',
  stale: 'border-warning/30 bg-warning/10 text-warning',
  denied: 'border-error/30 bg-error/10 text-error',
  resumed: 'border-success/30 bg-success/10 text-success',
  closed: 'border-border bg-surface-200 text-muted',
};
const WAIT_STATE_LABELS: Record<string, string> = {
  waiting_for_authorization: 'Waiting for authorization',
  waiting_for_authentication: 'Waiting for authentication',
  waiting_for_change_window: 'Waiting for change window',
};
const BINDING_HEALTH_LABELS: Record<AuthorityRequestDetailProjection['bindingHealth'], string> = {
  healthy: 'Healthy at latest adapter preflight',
  unhealthy: 'Unhealthy at latest adapter preflight',
  not_assessed: 'Not assessed by an authority preflight',
};
const ACTION_LABELS: Record<AuthorityAction, string> = {
  approve: 'Approve exact request',
  deny: 'Deny request',
  cancel: 'Cancel request',
};
const ACTION_REASON_CODES: Record<Exclude<AuthorityAction, 'cancel'>, readonly { value: string; label: string }[]> = {
  approve: [
    { value: 'scope_reviewed', label: 'Scope reviewed' },
    { value: 'change_window_confirmed', label: 'Change window confirmed' },
    { value: 'policy_exception_approved', label: 'Policy exception approved' },
  ],
  deny: [
    { value: 'scope_rejected', label: 'Scope rejected' },
    { value: 'evidence_insufficient', label: 'Evidence insufficient' },
    { value: 'binding_unhealthy', label: 'Binding unhealthy' },
    { value: 'request_not_needed', label: 'Request not needed' },
  ],
};
const EVIDENCE_KIND_LABELS: Record<ExecutionAuthorityEvidenceKind, string> = {
  migration: 'Migration',
  api: 'API',
  ui: 'UI',
  crash_recovery: 'Crash recovery',
  redaction: 'Redaction',
  disposable_fixture_smoke: 'Disposable fixture smoke',
};

function requestVisualState(request: AuthorityRequestProjection, now: number): RequestVisualState {
  if (request.status === 'pending') return Date.parse(request.expiresAt) <= now ? 'stale' : 'active';
  if (request.status === 'approved') return 'resumed';
  if (request.status === 'denied') return 'denied';
  return request.status === 'expired' ? 'stale' : 'closed';
}

function formatDate(value: string | null): string {
  if (!value) return 'Not available';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : 'Not available';
}

function ActionConfirmation({
  intent,
  request,
  pending,
  error,
  restoreFocusRef,
  onClose,
  onConfirm,
}: {
  intent: ConfirmationIntent;
  request: AuthorityRequestProjection;
  pending: boolean;
  error: string | null;
  restoreFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onConfirm: (reasonCode?: string) => void;
}) {
  const [reasonCode, setReasonCode] = useState(
    intent.action === 'approve' ? 'scope_reviewed' : intent.action === 'deny' ? 'scope_rejected' : '',
  );
  const titleId = `authority-${intent.action}-confirmation-title`;
  const dialogRef = useFocusTrap<HTMLDivElement>(true, restoreFocusRef, {
    onEscape: pending ? undefined : onClose,
  });
  const destructive = intent.action !== 'approve';
  const options = intent.action === 'cancel' ? [] : ACTION_REASON_CODES[intent.action];

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[var(--backdrop)] p-4" role="presentation">
      <section
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-xl rounded-xl border border-border bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          {destructive
            ? <AlertTriangle className="mt-0.5 shrink-0 text-error" size={20} aria-hidden="true" />
            : <ShieldCheck className="mt-0.5 shrink-0 text-accent" size={20} aria-hidden="true" />}
          <div className="min-w-0 flex-1">
            <p className={`text-xs font-semibold uppercase tracking-wide ${destructive ? 'text-error' : 'text-accent'}`}>
              {destructive ? 'Destructive authority decision' : 'Exact authority decision'}
            </p>
            <h2 id={titleId} className="mt-1 text-lg font-semibold text-[var(--text)]">
              {ACTION_LABELS[intent.action]}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label={`Close ${intent.action} confirmation`}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-200 hover:text-[var(--text)] disabled:opacity-50"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <p className="mt-4 text-sm text-muted">
          {intent.action === 'approve'
            ? 'Approval binds only the digest and scope shown below. The server revalidates the exact request and binding before issuing authority.'
            : intent.action === 'deny'
              ? 'Denial permanently resolves this request. The waiting run cannot use it.'
              : 'Cancellation permanently resolves this pending request and cannot be undone.'}
        </p>
        <dl className="mt-4 space-y-3 rounded-lg border border-border bg-bg p-4">
          <div>
            <dt className="text-xs text-muted">Exact request digest</dt>
            <dd className="mt-1 break-all font-mono text-xs text-[var(--text)]">{request.requestDigest}</dd>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><dt className="text-xs text-muted">Operation</dt><dd className="mt-1 text-sm text-[var(--text)]">{request.operation}</dd></div>
            <div><dt className="text-xs text-muted">Resource</dt><dd className="mt-1 break-all text-sm text-[var(--text)]">{request.providerResourceId}</dd></div>
          </div>
        </dl>

        {options.length > 0 && (
          <label className="mt-4 block text-sm font-medium text-[var(--text)]">
            Decision reason
            <select
              autoFocus
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value)}
              disabled={pending || Boolean(error)}
              className="mt-2 min-h-11 w-full rounded-lg border border-border bg-bg px-3 text-sm text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
            >
              {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        )}
        {error && <p role="alert" className="mt-4 rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error">{error}</p>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="min-h-11 rounded-lg border border-border px-4 text-sm text-[var(--text)] hover:bg-surface-200 disabled:opacity-50"
          >
            Go back
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reasonCode || undefined)}
            disabled={pending || Boolean(error)}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${destructive ? 'bg-error hover:bg-error/80' : 'bg-accent hover:bg-accent-hover'}`}
            aria-label={`Confirm ${intent.action} for exact request digest`}
          >
            {pending && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
            {pending ? 'Revalidating exact request…' : `Confirm ${intent.action}`}
          </button>
        </div>
      </section>
    </div>
  );
}

function DetailField({ label, children, mono = false }: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`min-w-0 break-words text-sm text-[var(--text)] ${mono ? 'font-mono text-xs' : ''}`}>{children}</dd>
    </div>
  );
}

function RunStateCard({ run }: { run: AuthorityRunStateProjection | null }) {
  if (!run) return <p className="text-sm text-muted">Run state is unavailable.</p>;
  const normalized = run.lifecycleStatus.toLowerCase();
  const waitLabel = WAIT_STATE_LABELS[normalized];
  return (
    <div className="rounded-lg border border-border bg-bg p-4" aria-label="Refreshed run state">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-[var(--text)]">Run #{run.runId}</span>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${waitLabel ? 'border-warning/30 bg-warning/10 text-warning' : 'border-border bg-surface-200 text-muted'}`}>
          {waitLabel ?? run.lifecycleStatus.replaceAll('_', ' ')}
        </span>
      </div>
      {waitLabel && (
        <div className="mt-3 space-y-1 text-xs">
          <p className="font-medium text-warning">Story execution timeout is stopped.</p>
          <p className="text-muted">Authority wait expiry: {formatDate(run.waitExpiresAt)}</p>
        </div>
      )}
    </div>
  );
}

export default function ExecutionAuthorityPanel() {
  const { workspaceId, selectedWorkspace } = useWorkspace();
  const [inboxState, setInboxState] = useState<InboxState>('loading');
  const [requests, setRequests] = useState<AuthorityRequestProjection[]>([]);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuthorityRequestDetailProjection | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [runState, setRunState] = useState<AuthorityRunStateProjection | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationIntent | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [profileState, setProfileState] = useState<InboxState>('loading');
  const [profile, setProfile] = useState<ExecutionAuthorityProfileProjection | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileMutationPending, setProfileMutationPending] = useState(false);
  const [profileStatusMessage, setProfileStatusMessage] = useState<string | null>(null);
  const selectedTriggerRef = useRef<HTMLElement | null>(null);
  const actionTriggerRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailAbortRef = useRef<AbortController | null>(null);

  const loadInbox = useCallback(async (signal?: AbortSignal) => {
    if (!workspaceId) {
      setRequests([]);
      setInboxState('ready');
      return;
    }
    setInboxError(null);
    try {
      const page = await listAuthorityRequests(workspaceId, signal);
      if (signal?.aborted) return;
      setRequests(page.items.filter((request) => request.workspaceId === workspaceId));
      setInboxState('ready');
      setNow(Date.now());
    } catch (error) {
      if (signal?.aborted) return;
      setRequests([]);
      setInboxError(authorityUiErrorMessage(error));
      setInboxState('error');
    }
  }, [workspaceId]);
  const loadProfile = useCallback(async (signal?: AbortSignal) => {
    if (!workspaceId) {
      setProfile(null);
      setProfileState('ready');
      return;
    }
    setProfileError(null);
    try {
      const nextProfile = await getExecutionAuthorityProfile(workspaceId, signal);
      if (signal?.aborted) return;
      setProfile(nextProfile);
      setProfileState('ready');
    } catch (error) {
      if (signal?.aborted) return;
      setProfile(null);
      setProfileError(authorityUiErrorMessage(error));
      setProfileState('error');
    }
  }, [workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    detailAbortRef.current?.abort();
    setInboxState('loading');
    setProfileState('loading');
    setRequests([]);
    setProfile(null);
    setSelectedRequestId(null);
    setDetail(null);
    setRunState(null);
    setConfirmation(null);
    setStatusMessage(null);
    setProfileStatusMessage(null);
    void Promise.all([loadInbox(controller.signal), loadProfile(controller.signal)]);
    return () => controller.abort();
  }, [loadInbox, loadProfile, workspaceId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleRequests = useMemo(() => {
    const rank: Record<RequestVisualState, number> = { active: 0, stale: 1, denied: 2, resumed: 3, closed: 4 };
    return [...requests].sort((left, right) => {
      const rankDifference = rank[requestVisualState(left, now)] - rank[requestVisualState(right, now)];
      return rankDifference || Date.parse(right.createdAt) - Date.parse(left.createdAt);
    });
  }, [now, requests]);

  const closeDetail = useCallback(() => {
    detailAbortRef.current?.abort();
    setSelectedRequestId(null);
    setDetail(null);
    setDetailError(null);
    setRunState(null);
    setConfirmation(null);
    setStatusMessage(null);
  }, []);

  const openDetail = useCallback(async (request: AuthorityRequestProjection, trigger: HTMLElement) => {
    if (!workspaceId) return;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    selectedTriggerRef.current = trigger;
    setSelectedRequestId(request.id);
    setDetail(null);
    setRunState(null);
    setDetailError(null);
    setStatusMessage(null);
    setDetailLoading(true);
    try {
      const [nextDetail, nextRun] = await Promise.all([
        getAuthorityRequestDetail(workspaceId, request.id, controller.signal),
        getAuthorityRunState(workspaceId, request.runId, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (nextDetail.request.workspaceId !== workspaceId || nextDetail.request.id !== request.id) {
        throw new Error('Authority request scope changed');
      }
      setDetail(nextDetail);
      setRunState(nextRun);
    } catch (error) {
      if (!controller.signal.aborted) setDetailError(authorityUiErrorMessage(error));
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }, [workspaceId]);

  const openConfirmation = useCallback((action: AuthorityAction, trigger: HTMLElement) => {
    if (!detail) return;
    actionTriggerRef.current = trigger;
    setConfirmationError(null);
    setConfirmation({
      action,
      requestId: detail.request.id,
      requestDigest: detail.request.requestDigest,
    });
  }, [detail]);

  const refreshAfterMutation = useCallback(async (
    requestId: string,
    runId: number,
    action: AuthorityAction,
  ) => {
    if (!workspaceId) return;
    const [nextDetail, nextRun, page] = await Promise.all([
      getAuthorityRequestDetail(workspaceId, requestId),
      getAuthorityRunState(workspaceId, runId),
      listAuthorityRequests(workspaceId),
    ]);
    setDetail(nextDetail);
    setRunState(nextRun);
    setRequests(page.items.filter((request) => request.workspaceId === workspaceId));
    setInboxState('ready');
    setNow(Date.now());
    setStatusMessage(`${ACTION_LABELS[action]} completed. Request and run state refreshed.`);
  }, [workspaceId]);

  const confirmMutation = useCallback(async (reasonCode?: string) => {
    if (!workspaceId || !confirmation || !detail) return;
    setMutationPending(true);
    setConfirmationError(null);
    const snapshot = confirmation;
    try {
      const current = await getAuthorityRequestDetail(workspaceId, snapshot.requestId);
      const changed = current.request.requestDigest !== snapshot.requestDigest
        || current.request.status !== 'pending'
        || Date.parse(current.request.expiresAt) <= Date.now();
      if (changed) {
        setDetail(current);
        setConfirmationError('This exact request is stale. Close this confirmation and review the refreshed digest and state.');
        return;
      }
      await mutateAuthorityRequest({
        workspaceId,
        requestId: snapshot.requestId,
        requestDigest: snapshot.requestDigest,
        action: snapshot.action,
        reasonCode,
      });
      setConfirmation(null);
      await refreshAfterMutation(snapshot.requestId, current.request.runId, snapshot.action);
    } catch (error) {
      const safeMessage = authorityUiErrorMessage(error);
      setConfirmationError(safeMessage);
      if (safeMessage.includes('stale')) {
        try {
          const current = await getAuthorityRequestDetail(workspaceId, snapshot.requestId);
          setDetail(current);
          await loadInbox();
        } catch {
          // Keep the fixed stale message; never reflect a second boundary error.
        }
      }
    } finally {
      setMutationPending(false);
    }
  }, [confirmation, detail, loadInbox, refreshAfterMutation, workspaceId]);
  const setProfileEnabled = useCallback(async (enabled: boolean) => {
    if (!workspaceId || !profile || profileMutationPending) return;
    if (!enabled && !window.confirm(
      'Disable Execution Authority for this workspace? New leases will stop and active grants and leases will be revoked.',
    )) return;
    setProfileMutationPending(true);
    setProfileError(null);
    setProfileStatusMessage(null);
    try {
      const updated = await transitionExecutionAuthorityProfile({
        workspaceId,
        enabled,
        expectedGeneration: profile.generation,
      });
      setProfile(updated);
      setProfileState('ready');
      setProfileStatusMessage(enabled
        ? 'Execution Authority enabled. No mutation-capable provider adapter is registered.'
        : 'Execution Authority disabled. Legacy local delivery is restored; receipts and audit history are preserved.');
      await loadInbox();
    } catch (error) {
      setProfileError(authorityUiErrorMessage(error));
    } finally {
      setProfileMutationPending(false);
    }
  }, [loadInbox, profile, profileMutationPending, workspaceId]);

  const handleRowKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let targetIndex: number | null = null;
    if (event.key === 'ArrowDown') targetIndex = Math.min(index + 1, visibleRequests.length - 1);
    else if (event.key === 'ArrowUp') targetIndex = Math.max(index - 1, 0);
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = visibleRequests.length - 1;
    if (targetIndex === null) return;
    event.preventDefault();
    const target = visibleRequests[targetIndex];
    if (target) rowRefs.current.get(target.id)?.focus();
  }, [visibleRequests]);

  const selectedRequest = detail?.request
    ?? requests.find((request) => request.id === selectedRequestId)
    ?? null;
  const selectedVisualState = selectedRequest ? requestVisualState(selectedRequest, now) : null;
  const actionsDisabled = !detail || detail.request.status !== 'pending' || selectedVisualState === 'stale' || mutationPending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppHeader
        breadcrumbs={(
          <div className="min-w-0">
            <span className="block truncate text-sm font-semibold text-[var(--text)]">Execution Authority</span>
            <span className="block truncate text-xs text-muted">Inspect and decide exact durable operation requests</span>
          </div>
        )}
        actions={(
          <button
            type="button"
            onClick={() => {
              setInboxState('loading');
              setProfileState('loading');
              void Promise.all([loadInbox(), loadProfile()]);
            }}
            disabled={(inboxState === 'loading' && profileState === 'loading') || !workspaceId}
            className="mr-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-panel px-3 text-sm font-medium text-[var(--text)] hover:bg-surface-200 disabled:opacity-50"
            aria-label="Refresh Execution Authority inbox"
          >
            <RefreshCw size={15} className={inboxState === 'loading' ? 'animate-spin' : ''} aria-hidden="true" />
            Refresh
          </button>
        )}
      />
      <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6" aria-labelledby="execution-authority-inbox-heading">
        <div className="mx-auto max-w-6xl">
          <section aria-labelledby="execution-authority-profile-heading" className="mb-6 rounded-xl border border-border bg-panel p-4 md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Workspace capability profile</p>
                <h1 id="execution-authority-profile-heading" className="mt-1 text-base font-semibold text-[var(--text)]">
                  Off-by-default Execution Authority
                </h1>
                <p className="mt-1 max-w-3xl text-sm text-muted">
                  Legacy local delivery remains unchanged while disabled. Enabling permits preflight waits only; no mutation-capable provider adapter is registered.
                </p>
              </div>
              {profile && (
                <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                  profile.state === 'enabled'
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-border bg-surface-200 text-muted'
                }`} role="status">
                  {profile.state === 'enabled' ? 'Enabled' : 'Disabled'}
                </span>
              )}
            </div>

            {profileState === 'loading' && (
              <p className="mt-4 flex items-center gap-2 text-sm text-muted" role="status">
                <Loader2 size={15} className="animate-spin" aria-hidden="true" /> Loading rollout profile…
              </p>
            )}
            {profileState === 'error' && (
              <p className="mt-4 rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error" role="alert">
                {profileError}
              </p>
            )}
            {profileState === 'ready' && profile && (
              <>
                <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Execution Authority rollout evidence">
                  {EXECUTION_AUTHORITY_EVIDENCE_KINDS.map((kind) => {
                    const evidence = profile.evidence.find((item) => item.evidenceKind === kind);
                    const passed = evidence?.result === 'passed';
                    return (
                      <div key={kind} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg px-3 py-2">
                        <span className="text-xs font-medium text-[var(--text)]">{EVIDENCE_KIND_LABELS[kind]}</span>
                        <span className={`inline-flex items-center gap-1 text-xs ${passed ? 'text-success' : 'text-warning'}`}>
                          {passed ? <ShieldCheck size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
                          {passed ? 'Passed' : evidence?.result === 'failed' ? 'Failed' : 'Missing'}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted">
                    Generation {profile.generation} · {profile.evidenceHistoryCount} retained evidence {profile.evidenceHistoryCount === 1 ? 'record' : 'records'} · {profile.mutationProviderAdapterIds.length} mutation adapters
                  </p>
                  <button
                    type="button"
                    onClick={() => void setProfileEnabled(profile.state !== 'enabled')}
                    disabled={profileMutationPending || (profile.state === 'disabled' && !profile.readyToEnable)}
                    className={`min-h-11 rounded-lg px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                      profile.state === 'enabled'
                        ? 'border border-error/40 text-error hover:bg-error/10'
                        : 'bg-accent text-white hover:bg-accent-hover'
                    }`}
                    aria-label={profile.state === 'enabled' ? 'Disable Execution Authority capability profile' : 'Enable Execution Authority capability profile'}
                  >
                    {profileMutationPending ? 'Applying…' : profile.state === 'enabled' ? 'Disable profile' : 'Enable profile'}
                  </button>
                </div>
                {profile.state === 'disabled' && !profile.readyToEnable && (
                  <p className="mt-3 text-xs text-warning" role="status">
                    Enablement blocked until all six current evidence classes pass.
                  </p>
                )}
                {profileStatusMessage && (
                  <p className="mt-3 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success" role="status" aria-live="polite">
                    {profileStatusMessage}
                  </p>
                )}
              </>
            )}
          </section>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 id="execution-authority-inbox-heading" className="text-lg font-semibold text-[var(--text)]">Approval inbox</h1>
              <p className="mt-1 text-sm text-muted">
                {selectedWorkspace?.name ?? workspaceId ?? 'Select a workspace'} · exact, reference-only authority requests
              </p>
            </div>
            {inboxState === 'ready' && requests.length > 0 && (
              <span className="rounded-full border border-border bg-panel px-3 py-1 text-xs text-muted" role="status">
                {requests.length} {requests.length === 1 ? 'request' : 'requests'}
              </span>
            )}
          </div>

          {inboxState === 'loading' && (
            <div className="flex min-h-64 items-center justify-center rounded-xl border border-border bg-panel" role="status" aria-live="polite">
              <div className="text-center">
                <Loader2 className="mx-auto animate-spin text-accent" size={28} aria-hidden="true" />
                <p className="mt-3 text-sm text-muted">Loading selected workspace requests…</p>
              </div>
            </div>
          )}

          {inboxState === 'error' && (
            <section className="rounded-xl border border-error/30 bg-error/10 p-6 text-center" role="alert">
              <AlertTriangle className="mx-auto text-error" size={28} aria-hidden="true" />
              <h2 className="mt-3 text-base font-semibold text-[var(--text)]">Authority inbox unavailable</h2>
              <p className="mt-2 text-sm text-error">{inboxError}</p>
              <button
                type="button"
                onClick={() => { setInboxState('loading'); void loadInbox(); }}
                className="mt-4 min-h-11 rounded-lg border border-error/30 px-4 text-sm font-medium text-[var(--text)] hover:bg-error/10"
              >
                Retry selected workspace
              </button>
            </section>
          )}

          {inboxState === 'ready' && requests.length === 0 && (
            <section className="rounded-xl border border-dashed border-border bg-panel p-10 text-center" role="status">
              <Inbox className="mx-auto text-muted" size={32} aria-hidden="true" />
              <h2 className="mt-3 text-base font-semibold text-[var(--text)]">No authority requests</h2>
              <p className="mt-2 text-sm text-muted">This workspace has no active or historical authority waits.</p>
            </section>
          )}

          {inboxState === 'ready' && visibleRequests.length > 0 && (
            <ol className="space-y-2" aria-label="Selected workspace authority requests">
              {visibleRequests.map((request, index) => {
                const visualState = requestVisualState(request, now);
                return (
                  <li key={request.id}>
                    <button
                      ref={(node) => {
                        if (node) rowRefs.current.set(request.id, node);
                        else rowRefs.current.delete(request.id);
                      }}
                      type="button"
                      onClick={(event) => void openDetail(request, event.currentTarget)}
                      onKeyDown={(event) => handleRowKeyDown(event, index)}
                      className="group grid w-full gap-3 rounded-xl border border-border bg-panel p-4 text-left transition-colors hover:border-accent/40 hover:bg-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:grid-cols-[minmax(0,1fr)_auto]"
                      aria-label={`Open authority request for run ${request.runId}, story ${request.storyId}, ${REQUEST_STATE_LABELS[visualState]}`}
                    >
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${REQUEST_STATE_CLASSES[visualState]}`}>
                            {REQUEST_STATE_LABELS[visualState]}
                          </span>
                          <span className="text-sm font-semibold text-[var(--text)]">{request.operation}</span>
                          <span className="text-xs text-muted">Run #{request.runId} · {request.storyId}</span>
                        </span>
                        <span className="mt-2 block break-all text-sm text-muted">{request.providerResourceId}</span>
                        <span className="mt-2 block truncate font-mono text-xs text-muted" title={request.requestDigest}>{request.requestDigest}</span>
                      </span>
                      <span className="flex items-center gap-3 self-center text-xs text-muted">
                        <span className="text-right">
                          <span className="block">Expires</span>
                          <span className="block text-[var(--text)]">{formatDate(request.expiresAt)}</span>
                        </span>
                        <ChevronRight className="text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" size={18} aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </main>

      <SlideOver
        isOpen={selectedRequestId !== null}
        onClose={closeDetail}
        title="Authority request detail"
        desktopMaxWidth={720}
        fullScreenBelowDesktop
        restoreFocusRef={selectedTriggerRef}
        contentClassName="bg-bg"
      >
        {detailLoading && (
          <div className="flex min-h-64 items-center justify-center" role="status">
            <Loader2 className="animate-spin text-accent" size={28} aria-hidden="true" />
            <span className="ml-3 text-sm text-muted">Loading exact request…</span>
          </div>
        )}
        {!detailLoading && detailError && (
          <div className="m-5 rounded-xl border border-error/30 bg-error/10 p-5" role="alert">
            <p className="text-sm text-error">{detailError}</p>
            {selectedRequest && (
              <button
                type="button"
                onClick={(event) => void openDetail(selectedRequest, event.currentTarget)}
                className="mt-4 min-h-11 rounded-lg border border-error/30 px-4 text-sm text-[var(--text)] hover:bg-error/10"
              >
                Retry exact request
              </button>
            )}
          </div>
        )}
        {!detailLoading && detail && selectedVisualState && (
          <div className="space-y-5 p-5 md:p-6">
            <section aria-labelledby="authority-exact-scope-heading" className="rounded-xl border border-border bg-panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Exact request</p>
                  <h2 id="authority-exact-scope-heading" className="mt-1 text-base font-semibold text-[var(--text)]">{detail.request.operation}</h2>
                </div>
                <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${REQUEST_STATE_CLASSES[selectedVisualState]}`} role="status">
                  {REQUEST_STATE_LABELS[selectedVisualState]}
                </span>
              </div>
              {selectedVisualState === 'stale' && (
                <p role="alert" className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                  This request is stale or expired. Decision controls are disabled until a new exact request is issued.
                </p>
              )}
              {selectedVisualState === 'denied' && (
                <p className="mt-4 rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error">This request was denied and cannot resume the operation.</p>
              )}
              {selectedVisualState === 'resumed' && (
                <p className="mt-4 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">This exact request was approved. The run state below was refreshed.</p>
              )}
              <dl className="mt-5 space-y-4">
                <DetailField label="Request digest" mono>{detail.request.requestDigest}</DetailField>
                <DetailField label="Requesting principal" mono>{detail.request.requestingPrincipal}</DetailField>
                <DetailField label="Operation">{detail.request.operation}</DetailField>
                <DetailField label="Resource">{detail.request.providerResourceId}</DetailField>
                <DetailField label="Environment">{detail.request.environment}</DetailField>
                <DetailField label="Capability">{detail.request.capabilityId}</DetailField>
                <DetailField label="Binding reference" mono>{detail.request.bindingReference}</DetailField>
                <DetailField label="Binding generation">{detail.request.bindingGeneration}</DetailField>
                <DetailField label="Binding health">
                  {BINDING_HEALTH_LABELS[detail.bindingHealth]}
                </DetailField>
                <DetailField label="Evidence digest" mono>{detail.request.evidenceDigest}</DetailField>
                <DetailField label="Run / story">
                  <Link
                    to={`/workspaces/${encodeURIComponent(detail.request.workspaceId)}/runs/${detail.request.runId}`}
                    className="font-medium text-accent hover:underline"
                  >
                    Run #{detail.request.runId} · {detail.request.storyId}
                  </Link>
                </DetailField>
                <DetailField label="Expires">{formatDate(detail.request.expiresAt)}</DetailField>
                <DetailField label="Maximum uses">{detail.request.maximumUses}</DetailField>
              </dl>
              <div className="mt-5">
                <p className="text-xs text-muted">Constraints</p>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg p-3 font-mono text-xs text-[var(--text)]">
                  {JSON.stringify(detail.request.constraints, null, 2)}
                </pre>
              </div>
            </section>

            {(detail.decision || detail.grant) && (
              <section aria-labelledby="authority-decision-heading" className="rounded-xl border border-border bg-panel p-4">
                <h2 id="authority-decision-heading" className="text-sm font-semibold text-[var(--text)]">Decision and use</h2>
                <dl className="mt-4 space-y-3">
                  {detail.decision && <DetailField label="Operator principal" mono>{detail.decision.operatorPrincipal}</DetailField>}
                  {detail.decision && <DetailField label="Reason">{detail.decision.reasonCode.replaceAll('_', ' ')}</DetailField>}
                  {detail.grant && <DetailField label="Uses">{detail.grant.usesConsumed} of {detail.grant.maximumUses}</DetailField>}
                  {detail.grant && <DetailField label="Fencing generation">{detail.grant.fencingGeneration}</DetailField>}
                </dl>
              </section>
            )}

            <section aria-labelledby="authority-run-state-heading" className="rounded-xl border border-border bg-panel p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 id="authority-run-state-heading" className="text-sm font-semibold text-[var(--text)]">Run state</h2>
                <button
                  type="button"
                  onClick={() => {
                    if (!workspaceId) return;
                    void getAuthorityRunState(workspaceId, detail.request.runId)
                      .then(setRunState)
                      .catch(() => setRunState(null));
                  }}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-200 hover:text-[var(--text)]"
                  aria-label="Refresh related run state"
                >
                  <RefreshCw size={15} aria-hidden="true" />
                </button>
              </div>
              <RunStateCard run={runState} />
            </section>

            {statusMessage && <p className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success" role="status" aria-live="polite">{statusMessage}</p>}

            <section aria-label="Authority request controls" className="sticky bottom-0 rounded-xl border border-border bg-panel p-4 shadow-lg">
              <div className="grid gap-2 sm:grid-cols-3">
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={(event) => openConfirmation('approve', event.currentTarget)}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Approve exact authority request"
                >
                  <Check size={16} aria-hidden="true" /> Approve
                </button>
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={(event) => openConfirmation('deny', event.currentTarget)}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-error/40 px-3 text-sm font-semibold text-error hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Deny authority request"
                >
                  <Ban size={16} aria-hidden="true" /> Deny
                </button>
                <button
                  type="button"
                  disabled={actionsDisabled}
                  onClick={(event) => openConfirmation('cancel', event.currentTarget)}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-warning/40 px-3 text-sm font-semibold text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Cancel authority request"
                >
                  <CircleStop size={16} aria-hidden="true" /> Cancel
                </button>
              </div>
              {actionsDisabled && detail.request.status === 'pending' && (
                <p className="mt-3 flex items-center gap-2 text-xs text-warning">
                  <Clock3 size={13} aria-hidden="true" /> Stale requests cannot be submitted.
                </p>
              )}
            </section>
          </div>
        )}
      </SlideOver>

      {confirmation && detail && (
        <ActionConfirmation
          intent={confirmation}
          request={detail.request}
          pending={mutationPending}
          error={confirmationError}
          restoreFocusRef={actionTriggerRef}
          onClose={() => { if (!mutationPending) { setConfirmation(null); setConfirmationError(null); } }}
          onConfirm={(reasonCode) => void confirmMutation(reasonCode)}
        />
      )}
    </div>
  );
}
