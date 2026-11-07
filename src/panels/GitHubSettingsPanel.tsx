/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useDeferredValue, useRef } from 'react';
import {
  Link2, Unlink, Loader2, CheckCircle2, AlertCircle,
  FileText, RotateCcw, Shield, ExternalLink,
  RefreshCw, KeyRound, RadioTower, Lock,
} from 'lucide-react';
import { Github } from '../components/icons/GithubIcon';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useGlobalToast } from '../contexts/ToastContext';
import {
  apiFetch,
  apiFetchProviderMutation,
  clearOperatorCapability,
  hasOperatorCapability,
  onOperatorCapabilityLocked,
  setOperatorCapability,
} from '../lib/apiFetch';
import AutonomousDeliverySettings from '../components/AutonomousDeliverySettings';

// ─── PR Template (duplicated from backend/src/lib/github/pr-template.ts) ──────

const DEFAULT_PR_TEMPLATE = `## Summary

{{spec.brief}}

## Stories

{{run.storiesPassed}}/{{run.storiesTotal}} stories passed

| Outcome | Count |
|---------|-------|
| ✅ Passed | {{run.storiesPassed}} |
| ❌ Failed | {{run.storiesFailed}} |
| ⏭ Skipped | {{run.storiesSkipped}} |

## Changes

\`\`\`
{{run.diffStats}}
\`\`\`

## Token Usage

| Metric | Value |
|--------|-------|
| Input tokens | {{run.tokensInput}} |
| Output tokens | {{run.tokensOutput}} |
| Total tokens | {{run.tokensTotal}} |
| Estimated cost | {{run.costUsd}} |

## Run Details

| Field | Value |
|-------|-------|
| Run ID | {{run.id}} |
| Duration | {{run.duration}} |
| Agent | {{run.agentType}} |
| Model | {{run.model}} |
| Spec | {{spec.title}} |

---
*Generated automatically by [Rorca](https://rorca.app)*`;

const SAMPLE_DATA: Record<string, string> = {
  'spec.title': 'rorca-go-to-market-v1',
  'spec.brief': 'Add repository-scoped GitHub integration and immutable per-run PR release templates.',
  'run.id': '42',
  'run.storiesPassed': '8',
  'run.storiesTotal': '10',
  'run.storiesFailed': '1',
  'run.storiesSkipped': '1',
  'run.tokensInput': '125,000',
  'run.tokensOutput': '18,000',
  'run.tokensTotal': '143,000',
  'run.costUsd': '$1.43',
  'run.duration': '12m 34s',
  'run.agentType': 'claude',
  'run.model': 'claude-opus-4-6',
  'run.diffStats': '12 files changed, 487 insertions(+), 23 deletions(-)',
};

function renderPreview(template: string): string {
  const tpl = template.trim() ? template : DEFAULT_PR_TEMPLATE;
  return tpl.replace(/\{\{([^}]+)\}\}/g, (match: string, key: string) => {
    const trimmed = key.trim();
    return Object.prototype.hasOwnProperty.call(SAMPLE_DATA, trimmed)
      ? SAMPLE_DATA[trimmed]
      : match;
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

type GithubBindingState = 'missing' | 'stale' | 'ready' | 'disabled';
type GithubAppAction = 'setup' | 'exchange' | 'bind' | 'revalidate' | 'disable';

interface GithubAppState {
  configured: boolean;
  connected?: boolean;
  credentialReady?: boolean;
  bindingState: GithubBindingState;
  source?: 'github-app-installation';
  appRegistration: { ready: boolean; appId: number | null; appSlug: string | null };
  registration?: { appId: number; appSlug: string } | null;
  app?: { id: number; slug: string };
  installation?: { id: number; accountId: number; account: string; type: string; status: string };
  repository?: { id: number; owner: string; name: string };
  binding?: {
    id: string;
    generation: number;
    status: 'active' | 'invalid' | 'disabled';
    lastValidatedAt: string | null;
    lastWebhookAt: string | null;
    validationErrorCode: string | null;
  };
  providerProfile: { verified: boolean; verifiedAt: string | null };
  grantedPermissions: Record<string, string>;
  tokenMintProbe: {
    status: 'unavailable' | 'required' | 'passed' | 'failed' | 'disabled';
    checkedAt: string | null;
    errorCode: string | null;
  };
  capabilityAvailability: Record<string, boolean>;
  webhookHealth?: { configured: boolean; signedDeliveryObserved: boolean; lastWebhookAt: string | null };
  nextAction: string | null;
}

interface GithubAppSetupResult {
  mode: 'manifest' | 'unavailable';
  state?: string;
  expiresAt?: string;
  createUrl?: string;
  manifest?: Record<string, unknown>;
  nextAction: string;
}

interface PrTemplatePreviewResult {
  rendered: string;
  source: 'latest-run' | 'sample';
  run: {
    id?: number;
    status?: string | null;
    title?: string;
    storiesPassed?: number;
    storiesTotal?: number;
  } | null;
}

const EMPTY_APP_STATE: GithubAppState = {
  configured: false,
  bindingState: 'missing',
  appRegistration: { ready: false, appId: null, appSlug: null },
  providerProfile: { verified: false, verifiedAt: null },
  grantedPermissions: {},
  tokenMintProbe: { status: 'unavailable', checkedAt: null, errorCode: null },
  capabilityAvailability: {},
  nextAction: 'Register the canonical GitHub App.',
};

function normalizeGithubAppState(state: Partial<GithubAppState>): GithubAppState {
  const legacyRegistration = state.registration
    ?? (state.app ? { appId: state.app.id, appSlug: state.app.slug } : null);
  return {
    ...EMPTY_APP_STATE,
    ...state,
    bindingState: state.bindingState ?? (state.connected ? 'ready' : 'missing'),
    appRegistration: state.appRegistration ?? {
      ready: Boolean(legacyRegistration),
      appId: legacyRegistration?.appId ?? null,
      appSlug: legacyRegistration?.appSlug ?? null,
    },
    providerProfile: state.providerProfile ?? EMPTY_APP_STATE.providerProfile,
    grantedPermissions: state.grantedPermissions ?? EMPTY_APP_STATE.grantedPermissions,
    tokenMintProbe: state.tokenMintProbe ?? EMPTY_APP_STATE.tokenMintProbe,
    capabilityAvailability: state.capabilityAvailability
      ?? ('capabilities' in state
        ? (state as GithubAppState & { capabilities?: Record<string, boolean> }).capabilities ?? {}
        : {}),
  };
}

// ─── Scope descriptions ─────────────────────────────────────────────────────

const BINDING_STATE_LABEL: Record<GithubBindingState | 'loading' | 'revalidation' | 'error', string> = {
  loading: 'Loading',
  missing: 'Missing',
  stale: 'Stale',
  ready: 'Ready',
  revalidation: 'Revalidation in progress',
  disabled: 'Disabled',
  error: 'Error',
};

const PR_TEMPLATE_VARIABLES = [
  '{{spec.title}}', '{{spec.brief}}',
  '{{run.storiesPassed}}', '{{run.storiesTotal}}',
  '{{run.storiesFailed}}', '{{run.storiesSkipped}}',
  '{{run.tokensInput}}', '{{run.tokensOutput}}', '{{run.tokensTotal}}',
  '{{run.costUsd}}', '{{run.duration}}',
  '{{run.agentType}}', '{{run.model}}',
  '{{run.id}}', '{{run.diffStats}}',
];

function qualificationTime(value?: string | null): string {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unavailable';
}

function timeAgo(value?: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Never';
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (elapsedSeconds < 60) return 'Just now';
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3600)}h ago`;
  return `${Math.floor(elapsedSeconds / 86_400)}d ago`;
}

function StatusPill({ ok, label, warn }: { ok: boolean; label: string; warn?: boolean }) {
  const color = ok
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : warn
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
      : 'border-border bg-bg text-muted';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${color}`}>
      {ok ? <CheckCircle2 size={12} /> : warn ? <AlertCircle size={12} /> : <Lock size={12} />}
      {label}
    </span>
  );
}

function LockedPanel({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-panel/50 p-4 text-sm text-muted">
      <div className="flex items-center gap-2 text-[var(--text)] mb-1">
        <Lock size={14} />
        <span className="font-medium">{title}</span>
      </div>
      {message}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function GitHubSettingsPanel() {
  const { workspaceId } = useWorkspace();
  const { show: showToast } = useGlobalToast();
  const capabilityInputRef = useRef<HTMLInputElement>(null);
  const capabilityWorkspaceRef = useRef<string | null>(null);
  const [providerChangesUnlocked, setProviderChangesUnlocked] = useState(false);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);

  useEffect(() => {
    if (capabilityWorkspaceRef.current !== null && capabilityWorkspaceRef.current !== workspaceId) {
      clearOperatorCapability();
    }
    capabilityWorkspaceRef.current = workspaceId;
    setProviderChangesUnlocked(hasOperatorCapability());
    const unsubscribe = onOperatorCapabilityLocked(() => setProviderChangesUnlocked(false));
    const lockForPageClose = () => clearOperatorCapability();
    window.addEventListener('pagehide', lockForPageClose);
    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', lockForPageClose);
    };
  }, [workspaceId]);

  function handleUnlockProviderChanges() {
    const capability = capabilityInputRef.current?.value ?? '';
    try {
      setOperatorCapability(capability);
      if (capabilityInputRef.current) capabilityInputRef.current.value = '';
      setProviderChangesUnlocked(hasOperatorCapability());
      setCapabilityError(null);
    } catch (error) {
      setProviderChangesUnlocked(false);
      setCapabilityError(error instanceof Error ? error.message : 'Enter a valid operator capability');
    }
  }

  function handleLockProviderChanges() {
    clearOperatorCapability();
    if (capabilityInputRef.current) capabilityInputRef.current.value = '';
    setProviderChangesUnlocked(false);
    setCapabilityError(null);
  }

  // Repository-scoped GitHub App qualification
  const appStateRequestGenerationRef = useRef(0);
  const appStateWorkspaceRef = useRef(workspaceId);
  appStateWorkspaceRef.current = workspaceId;
  const [appStateSnapshot, setAppStateSnapshot] = useState<{
    workspaceId: string;
    state: GithubAppState;
  } | null>(null);
  const appState = appStateSnapshot?.workspaceId === workspaceId ? appStateSnapshot.state : null;
  const [appLoading, setAppLoading] = useState(true);
  const [appSetup, setAppSetup] = useState<GithubAppSetupResult | null>(null);
  const [appActionError, setAppActionError] = useState<string | null>(null);
  const [appAction, setAppAction] = useState<GithubAppAction | null>(null);
  const [installationId, setInstallationId] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [appRepoOwner, setAppRepoOwner] = useState('');
  const [appRepoName, setAppRepoName] = useState('');
  const [replacementReason, setReplacementReason] = useState('');

  // PR template
  const [prTemplate, setPrTemplate] = useState('');
  const [prTemplateSaving, setPrTemplateSaving] = useState(false);
  const [prTemplateSaved, setPrTemplateSaved] = useState(false);
  const [prTemplateLoaded, setPrTemplateLoaded] = useState(false);
  const [prTemplatePreviewVisible, setPrTemplatePreviewVisible] = useState(false);
  const [prTemplatePreview, setPrTemplatePreview] = useState<PrTemplatePreviewResult | null>(null);
  const [prTemplatePreviewLoading, setPrTemplatePreviewLoading] = useState(false);
  const [prTemplatePreviewError, setPrTemplatePreviewError] = useState<string | null>(null);
  // Deferred so the preview update doesn't block keystrokes
  const deferredPrTemplate = useDeferredValue(prTemplate);
  const previewText = prTemplatePreview?.rendered ?? renderPreview(deferredPrTemplate);


  const fetchAppState = useCallback(async () => {
    const requestedWorkspaceId = workspaceId;
    if (!requestedWorkspaceId || appStateWorkspaceRef.current !== requestedWorkspaceId) return;
    const requestGeneration = ++appStateRequestGenerationRef.current;
    setAppLoading(true);
    setAppActionError(null);
    try {
      const state = normalizeGithubAppState(
        await apiFetch<Partial<GithubAppState>>(`/api/workspaces/${requestedWorkspaceId}/github/app`),
      );
      if (requestGeneration !== appStateRequestGenerationRef.current
        || appStateWorkspaceRef.current !== requestedWorkspaceId) return;
      setAppStateSnapshot({ workspaceId: requestedWorkspaceId, state });
    } catch (err: unknown) {
      if (requestGeneration !== appStateRequestGenerationRef.current
        || appStateWorkspaceRef.current !== requestedWorkspaceId) return;
      setAppStateSnapshot({ workspaceId: requestedWorkspaceId, state: EMPTY_APP_STATE });
      setAppActionError(err instanceof Error ? err.message : 'Failed to load GitHub App state');
    } finally {
      if (requestGeneration === appStateRequestGenerationRef.current
        && appStateWorkspaceRef.current === requestedWorkspaceId) setAppLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setAppSetup(null);
    setAppAction(null);
    setAppActionError(null);
    setInstallationId('');
    setRepositoryId('');
    setAppRepoOwner('');
    setAppRepoName('');
    setReplacementReason('');
    void fetchAppState();
    return () => { appStateRequestGenerationRef.current += 1; };
  }, [fetchAppState]);

  // ─── Fetch PR template from rorca-config ────────────────────────────────

  useEffect(() => {
    if (!workspaceId || prTemplateLoaded) return;
    apiFetch<{ config: { github?: { prTemplate?: string } } }>(`/api/workspaces/${workspaceId}/rorca-config`)
      .then(data => {
        setPrTemplate(data.config.github?.prTemplate ?? '');
        setPrTemplateLoaded(true);
      })
      .catch(() => { setPrTemplateLoaded(true); });
  }, [workspaceId, prTemplateLoaded]);

  useEffect(() => {
    if (!workspaceId || !prTemplatePreviewVisible || !prTemplateLoaded) return;
    let cancelled = false;
    setPrTemplatePreviewLoading(true);
    setPrTemplatePreviewError(null);
    apiFetch<PrTemplatePreviewResult>(`/api/workspaces/${workspaceId}/github/pr-template-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: deferredPrTemplate }),
    })
      .then(data => { if (!cancelled) setPrTemplatePreview(data); })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPrTemplatePreview(null);
          setPrTemplatePreviewError(err instanceof Error ? err.message : 'Using local sample preview');
        }
      })
      .finally(() => { if (!cancelled) setPrTemplatePreviewLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, prTemplatePreviewVisible, prTemplateLoaded, deferredPrTemplate]);

  const callbackParams = new URLSearchParams(window.location.search);
  const appCallbackReady = callbackParams.get('github_app_setup') === 'callback'
    && Boolean(callbackParams.get('state')) && Boolean(callbackParams.get('code'));
  const appReady = appState?.bindingState === 'ready';
  const appActionLoading = appAction !== null;
  const appStateBelongsToWorkspace = appStateSnapshot?.workspaceId === workspaceId;
  const bindingUiState: GithubBindingState | 'loading' | 'revalidation' | 'error' = appLoading || !appStateBelongsToWorkspace
    ? 'loading'
    : appAction === 'revalidate'
      ? 'revalidation'
      : appActionError
        ? 'error'
        : appState?.bindingState ?? 'missing';
  const appCanBindOrReplace = Boolean(
    appState?.appRegistration.ready
    && ['missing', 'stale', 'disabled'].includes(appState.bindingState),
  );
  const registeredAppSlug = appState?.appRegistration.appSlug;
  const permissionEntries = Object.entries(appState?.grantedPermissions ?? {});
  const capabilityEntries = Object.entries(appState?.capabilityAvailability ?? {});

  function appActionWorkspaceIsCurrent(actionWorkspaceId: string): boolean {
    return appStateWorkspaceRef.current === actionWorkspaceId;
  }

  async function handleStartAppSetup() {
    if (!workspaceId || !providerChangesUnlocked) return;
    const actionWorkspaceId = workspaceId;
    setAppAction('setup');
    setAppActionError(null);
    try {
      const setup = await apiFetchProviderMutation<GithubAppSetupResult>(
        `/api/workspaces/${actionWorkspaceId}/github/app/setup/start`,
        { method: 'POST' },
      );
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) setAppSetup(setup);
    } catch (err: unknown) {
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) {
        setAppActionError(err instanceof Error ? err.message : 'Failed to prepare GitHub App setup');
      }
    } finally {
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) setAppAction(null);
    }
  }

  async function handleExchangeAppManifest() {
    if (!workspaceId || !providerChangesUnlocked) return;
    const actionWorkspaceId = workspaceId;
    const params = new URLSearchParams(window.location.search);
    const state = params.get('state');
    const code = params.get('code');
    if (!state || !code) return;
    setAppAction('exchange');
    setAppActionError(null);
    try {
      await apiFetchProviderMutation(`/api/workspaces/${actionWorkspaceId}/github/app/setup/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, code }),
      });
      if (!appActionWorkspaceIsCurrent(actionWorkspaceId)) return;
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
      await fetchAppState();
    } catch (err: unknown) {
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) {
        setAppActionError(err instanceof Error ? err.message : 'GitHub App manifest exchange failed');
      }
    } finally {
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) setAppAction(null);
    }
  }


  async function handleRevalidateAppBinding() {
    if (!workspaceId || !providerChangesUnlocked) return;
    const actionWorkspaceId = workspaceId;
    setAppAction('revalidate');
    setAppActionError(null);
    try {
      await apiFetchProviderMutation(`/api/workspaces/${actionWorkspaceId}/github/app/revalidate`, { method: 'POST' });
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) await fetchAppState();
    } catch (err: unknown) {
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) {
        setAppActionError(err instanceof Error ? err.message : 'Failed to revalidate App binding');
      }
    } finally {
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) setAppAction(null);
    }
  }

  async function handleBindAppRepository() {
    if (!workspaceId || !providerChangesUnlocked) return;
    const actionWorkspaceId = workspaceId;
    setAppAction('bind');
    setAppActionError(null);
    try {
      await apiFetchProviderMutation(`/api/workspaces/${actionWorkspaceId}/github/app/bind`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: Number(installationId),
          repositoryId: Number(repositoryId),
          repoOwner: appRepoOwner.trim(),
          repoName: appRepoName.trim(),
          replacementReason: appState?.configured ? replacementReason.trim() : undefined,
        }),
      });
      if (!appActionWorkspaceIsCurrent(actionWorkspaceId)) return;
      setReplacementReason('');
      await fetchAppState();
    } catch (err: unknown) {
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) {
        setAppActionError(err instanceof Error ? err.message : 'Failed to bind App installation');
      }
    } finally {
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) setAppAction(null);
    }
  }

  async function handleDisableAppBinding() {
    if (!workspaceId || !providerChangesUnlocked) return;
    const actionWorkspaceId = workspaceId;
    setAppAction('disable');
    setAppActionError(null);
    try {
      await apiFetchProviderMutation(`/api/workspaces/${actionWorkspaceId}/github/app/disable`, { method: 'POST' });
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) await fetchAppState();
    } catch (err: unknown) {
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) {
        setAppActionError(err instanceof Error ? err.message : 'Failed to disable App binding');
      }
    } finally {
      if (appActionWorkspaceIsCurrent(actionWorkspaceId)) setAppAction(null);
    }
  }

  async function handleSavePrTemplate() {
    if (!workspaceId || prTemplateSaving) return;
    setPrTemplateSaving(true);
    try {
      // Read-merge-write to avoid clobbering other config sections
      const current = await apiFetch<{ config: Record<string, unknown> }>(`/api/workspaces/${workspaceId}/rorca-config`);
      const merged = {
        ...current.config,
        github: {
          ...(typeof current.config.github === 'object' && current.config.github !== null ? current.config.github : {}),
          prTemplate: prTemplate || undefined,
        },
      };
      await apiFetch(`/api/workspaces/${workspaceId}/rorca-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: merged }),
      });
      setPrTemplateSaved(true);
      setTimeout(() => setPrTemplateSaved(false), 2000);
    } catch {
      // silent
    } finally {
      setPrTemplateSaving(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Select a workspace first.
      </div>
    );
  }

  return (
    <div
      role="main"
      aria-label="GitHub Settings"
      className="h-full overflow-y-auto max-w-5xl mx-auto space-y-6 px-4 pb-10 sm:px-0"
    >
      <section className="rounded-2xl border border-border bg-panel/80 p-4 shadow-xl shadow-black/10 overflow-hidden relative">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Github size={22} strokeWidth={1.5} />
              <h1 className="text-xl font-semibold text-[var(--text)]">GitHub Integration</h1>
            </div>
            <p className="max-w-2xl text-sm text-muted">
              Qualify one immutable GitHub App installation and repository binding. External delivery remains unavailable unless the binding and its exact permission profile are healthy.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill
              ok={Boolean(appState?.appRegistration.ready)}
              label={appState?.appRegistration.ready ? 'App registration ready' : 'App registration missing'}
            />
            <StatusPill
              ok={appReady}
              warn={['stale', 'revalidation'].includes(bindingUiState)}
              label={`Binding ${BINDING_STATE_LABEL[bindingUiState].toLowerCase()}`}
            />
            <StatusPill
              ok={appState?.tokenMintProbe.status === 'passed'}
              warn={appState?.tokenMintProbe.status === 'required' || appState?.tokenMintProbe.status === 'failed'}
              label={`Token-mint probe ${appState?.tokenMintProbe.status ?? 'unavailable'}`}
            />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
          {[
            {
              icon: KeyRound,
              title: 'App registration',
              value: appState?.appRegistration.ready ? appState.appRegistration.appSlug ?? 'Ready' : 'Not registered',
              tone: appState?.appRegistration.ready ? 'text-emerald-300' : 'text-muted',
            },
            {
              icon: Github,
              title: 'Repository binding',
              value: appState?.repository ? `${appState.repository.owner}/${appState.repository.name}` : 'Not bound',
              tone: appReady ? 'text-emerald-300' : bindingUiState === 'disabled' ? 'text-red-300' : 'text-muted',
            },
            {
              icon: RadioTower,
              title: 'Provider profile',
              value: appState?.providerProfile.verified ? 'Verified' : 'Not verified',
              tone: appState?.providerProfile.verified ? 'text-emerald-300' : 'text-muted',
            },
          ].map(item => {
            const Icon = item.icon;
            return (
              <div key={item.title} className="rounded-xl border border-border bg-bg/60 p-2.5">
                <div className="flex items-center gap-2 text-xs text-muted"><Icon size={14} />{item.title}</div>
                <div className={`mt-1.5 truncate text-sm font-medium ${item.tone}`}>{item.value}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-4 space-y-3" aria-labelledby="github-operator-capability-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Lock size={16} />
              <h2 id="github-operator-capability-heading" className="text-sm font-semibold text-[var(--text)]">Provider changes lock</h2>
              <StatusPill
                ok={providerChangesUnlocked}
                label={providerChangesUnlocked ? 'Unlocked for this visit' : 'Locked'}
              />
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted">
              Read-only GitHub diagnostics stay available while locked. Enter the local operator capability only when you intend to change provider or release authority. The value is retained in memory only, attached only to approved operator mutations, and cleared on workspace change, rejection, sign-out, page close, or explicit lock.
            </p>
          </div>
          {providerChangesUnlocked && (
            <button type="button" onClick={handleLockProviderChanges}
              className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-bg">
              <Lock size={12} />Lock provider changes
            </button>
          )}
        </div>
        {!providerChangesUnlocked && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-xs text-muted">Local operator capability
              <input
                ref={capabilityInputRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleUnlockProviderChanges();
                  }
                }}
                className="mt-1 w-full rounded border border-border bg-bg px-3 py-1.5 font-mono text-sm text-[var(--text)] focus:outline-none focus:border-accent"
              />
            </label>
            <button type="button" onClick={handleUnlockProviderChanges}
              className="inline-flex items-center justify-center gap-1.5 rounded bg-accent px-3 py-2 text-xs text-white">
              <KeyRound size={12} />Unlock provider changes
            </button>
          </div>
        )}
        {capabilityError && <p role="alert" className="text-xs text-red-400">{capabilityError}</p>}
      </section>

      <section className="rounded-lg border border-border bg-panel p-4 space-y-4" aria-labelledby="github-app-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Shield size={18} />
              <h2 id="github-app-heading" className="text-sm font-semibold text-[var(--text)]">Repository binding</h2>
              {bindingUiState === 'loading' && <Loader2 size={13} className="animate-spin text-muted" />}
              <span
                role="status"
                aria-label="Repository binding state"
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  bindingUiState === 'ready'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : bindingUiState === 'error' || bindingUiState === 'disabled'
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                }`}
              >
                {BINDING_STATE_LABEL[bindingUiState]}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted">
              One path binds the selected installation to one immutable repository identity. The server performs provider identity, permission, and short-lived credential-mint probes; credential values never return to this page.
            </p>
          </div>
          {!appState?.appRegistration.ready && (
            <button
              type="button"
              onClick={handleStartAppSetup}
              disabled={appActionLoading || !providerChangesUnlocked}
              title={providerChangesUnlocked ? undefined : 'Unlock provider changes before registering the App'}
              className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {appAction === 'setup' ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
              Prepare App setup
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-bg/50 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <span className="text-muted">App registration</span>
            <p className="mt-1 font-medium text-[var(--text)]">
              {appState?.appRegistration.ready ? `${appState.appRegistration.appSlug} · #${appState.appRegistration.appId}` : 'Missing'}
            </p>
          </div>
          <div>
            <span className="text-muted">Installation / repository</span>
            <p className="mt-1 font-mono text-[var(--text)]">
              {appState?.installation && appState.repository
                ? `#${appState.installation.id} · ${appState.repository.owner}/${appState.repository.name} · #${appState.repository.id}`
                : 'Not bound'}
            </p>
          </div>
          <div>
            <span className="text-muted">Verified profile</span>
            <p className="mt-1 font-medium text-[var(--text)]">
              {appState?.providerProfile.verified ? `Verified · ${qualificationTime(appState.providerProfile.verifiedAt)}` : 'Not verified'}
            </p>
          </div>
          <div>
            <span className="text-muted">Binding generation</span>
            <p className="mt-1 font-mono text-[var(--text)]">{appState?.binding?.generation ?? '—'}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-bg/50 p-3">
            <p className="text-xs font-medium text-muted">Granted App permissions</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {permissionEntries.length ? permissionEntries.map(([name, level]) => (
                <span key={name} className="rounded border border-border bg-panel px-2 py-1 font-mono text-xs text-[var(--text)]">
                  {name}:{level}
                </span>
              )) : <span className="text-xs text-muted">No granted permission profile.</span>}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-bg/50 p-3">
            <p className="text-xs font-medium text-muted">SCM capability availability</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {capabilityEntries.length ? capabilityEntries.map(([name, available]) => (
                <span key={name} className={`inline-flex items-center gap-1 rounded border px-2 py-1 font-mono text-xs ${
                  available
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                }`}>
                  {available ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}{name}
                </span>
              )) : <span className="text-xs text-muted">No capabilities are available.</span>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg/50 p-3 text-xs">
          <span className="text-muted">Token-mint probe</span>
          <StatusPill
            ok={appState?.tokenMintProbe.status === 'passed'}
            warn={appState?.tokenMintProbe.status === 'required' || appState?.tokenMintProbe.status === 'failed'}
            label={appState?.tokenMintProbe.status ?? 'unavailable'}
          />
          <span className="text-muted">Checked: {qualificationTime(appState?.tokenMintProbe.checkedAt)}</span>
          {appState?.tokenMintProbe.errorCode && (
            <span className="font-mono text-red-300">{appState.tokenMintProbe.errorCode}</span>
          )}
        </div>

        {appState?.webhookHealth && (
          <div className="flex flex-wrap gap-2" aria-label="GitHub App webhook health">
            <StatusPill ok={appState.webhookHealth.configured} label={appState.webhookHealth.configured ? 'Provider hook configured' : 'Provider hook not configured'} />
            <StatusPill
              ok={appState.webhookHealth.signedDeliveryObserved}
              warn={appState.webhookHealth.configured && !appState.webhookHealth.signedDeliveryObserved}
              label={appState.webhookHealth.signedDeliveryObserved ? 'Signed delivery observed' : 'Awaiting signed delivery'}
            />
            <span className="self-center text-xs text-muted">Last signed delivery: {timeAgo(appState.webhookHealth.lastWebhookAt)}</span>
          </div>
        )}

        {appCanBindOrReplace && registeredAppSlug && (
          <div className="space-y-3 rounded-lg border border-border bg-bg/50 p-3">
            <p className="text-xs text-muted">
              Registered App: <span className="font-medium text-[var(--text)]">{registeredAppSlug}</span>. Enter only the public installation and repository identities; the server proves all four against GitHub before {appState?.configured ? 'audit-replacing' : 'binding'}.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: 'Installation ID', value: installationId, set: setInstallationId, placeholder: '12345678' },
                { label: 'Repository ID', value: repositoryId, set: setRepositoryId, placeholder: '987654321' },
                { label: 'Owner', value: appRepoOwner, set: setAppRepoOwner, placeholder: 'owner' },
                { label: 'Repository', value: appRepoName, set: setAppRepoName, placeholder: 'repo' },
              ].map(field => (
                <label key={field.label} className="text-xs text-muted">{field.label}
                  <input
                    value={field.value}
                    onChange={event => field.set(event.target.value)}
                    placeholder={field.placeholder}
                    className="mt-1 w-full rounded border border-border bg-panel px-2.5 py-1.5 font-mono text-xs text-[var(--text)] focus:outline-none focus:border-accent"
                  />
                </label>
              ))}
            </div>
            {appState?.configured && (
              <label className="block text-xs text-muted">Audited replacement reason
                <input
                  value={replacementReason}
                  onChange={event => setReplacementReason(event.target.value)}
                  placeholder="Why this immutable binding is being replaced"
                  className="mt-1 w-full rounded border border-border bg-panel px-2.5 py-1.5 text-xs text-[var(--text)] focus:outline-none focus:border-accent"
                />
              </label>
            )}
            <button
              type="button"
              onClick={handleBindAppRepository}
              disabled={appActionLoading || !providerChangesUnlocked || !installationId || !repositoryId
                || !appRepoOwner.trim() || !appRepoName.trim()
                || Boolean(appState?.configured && replacementReason.trim().length < 8)}
              title={providerChangesUnlocked ? undefined : 'Unlock provider changes before binding a repository'}
              className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {appAction === 'bind' ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
              {appState?.configured ? 'Verify and audit-replace exact repository' : 'Verify and bind exact repository'}
            </button>
          </div>
        )}

        {appCallbackReady && (
          <button
            type="button"
            onClick={handleExchangeAppManifest}
            disabled={appActionLoading || !providerChangesUnlocked}
            className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {appAction === 'exchange' ? <Loader2 size={12} className="animate-spin" /> : <Shield size={12} />}
            Complete one-time App registration
          </button>
        )}

        {appSetup?.mode === 'manifest' && appSetup.manifest && appSetup.createUrl && (
          <form action={appSetup.createUrl} method="post" target="_blank" rel="noopener noreferrer" className="rounded-lg border border-border bg-bg/50 p-3 space-y-2">
            <input type="hidden" name="manifest" value={JSON.stringify(appSetup.manifest)} />
            <p className="text-xs text-muted">{appSetup.nextAction} State expires {appSetup.expiresAt ? new Date(appSetup.expiresAt).toLocaleTimeString() : 'soon'}.</p>
            <button type="submit" className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-panel">
              <ExternalLink size={12} />Continue to GitHub
            </button>
          </form>
        )}
        {appSetup?.mode === 'unavailable' && (
          <p role="status" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            {appSetup.nextAction}
          </p>
        )}

        {appState?.configured && appState.bindingState !== 'disabled' && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleRevalidateAppBinding}
              disabled={appActionLoading || !providerChangesUnlocked}
              title={providerChangesUnlocked ? undefined : 'Unlock provider changes before revalidation'}
              className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {appAction === 'revalidate' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Revalidate immutable binding
            </button>
            <button
              type="button"
              onClick={handleDisableAppBinding}
              disabled={appActionLoading || !providerChangesUnlocked}
              title={providerChangesUnlocked ? undefined : 'Unlock provider changes before disabling this binding'}
              className="inline-flex items-center gap-1.5 rounded border border-red-500/30 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {appAction === 'disable' ? <Loader2 size={12} className="animate-spin" /> : <Unlink size={12} />}
              Disable repository binding
            </button>
          </div>
        )}

        {(appState?.nextAction || appActionError) && (
          <div
            role={appActionError ? 'alert' : 'status'}
            aria-live="polite"
            className={`flex items-start gap-2 text-xs ${appActionError ? 'text-red-400' : 'text-amber-300'}`}
          >
            <AlertCircle size={13} className="mt-0.5 shrink-0" />{appActionError || appState?.nextAction}
          </div>
        )}
      </section>

      <AutonomousDeliverySettings
        workspaceId={workspaceId}
        connected={appReady}
        showToast={showToast}
      />


      <section className="border-t border-border pt-6 pb-6" aria-labelledby="github-release-behavior-heading">
        <div className="flex items-center gap-2 mb-3">
          <Shield size={18} />
          <h2 id="github-release-behavior-heading" className="text-sm font-semibold text-[var(--text)]">Release behavior</h2>
        </div>
        <div className="rounded-lg border border-border bg-panel p-4 space-y-2 text-xs text-muted">
          <p>Repository-level Auto-PR and workflow-dispatch settings are retired. Rorca does not generate or dispatch autonomous GitHub Actions workflows.</p>
          <p>Choose <code className="bg-bg px-1 rounded">pr</code>, <code className="bg-bg px-1 rounded">draft-pr</code>, <code className="bg-bg px-1 rounded">branch-only</code>, or <code className="bg-bg px-1 rounded">direct</code> on each pipeline run. The chosen strategy, exact SHA, base branch, and repository identity are frozen in that run&apos;s immutable release intent.</p>
        </div>
      </section>

      {/* ─── Section 6: PR Template ───────────────────────────────────── */}
      <section className="border-t border-border pt-6 pb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileText size={18} />
            <h2 className="text-sm font-semibold text-[var(--text)]">PR Description Template</h2>
          </div>
          <button
            onClick={() => setPrTemplatePreviewVisible(v => !v)}
            disabled={!appReady}
            className="text-xs text-muted hover:text-[var(--text)] transition-colors border border-border rounded px-2 py-1 disabled:opacity-50 disabled:hover:text-muted"
          >
            {prTemplatePreviewVisible ? 'Hide Preview' : 'Preview latest run'}
          </button>
        </div>

        <div className="mb-3 space-y-2">
          <p className="text-xs text-muted">
            Customize the PR description used when a run explicitly selects the immutable <code className="bg-bg px-1 rounded">pr</code> or <code className="bg-bg px-1 rounded">draft-pr</code> release strategy. Unrecognized variables are left as-is.
          </p>
          <details className="rounded-lg border border-border bg-panel/50 px-3 py-2 text-xs text-muted">
            <summary className="cursor-pointer select-none text-[var(--text)]">Supported template variables</summary>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PR_TEMPLATE_VARIABLES.map(variable => (
                <code key={variable} className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[11px] text-muted">
                  {variable}
                </code>
              ))}
            </div>
          </details>
        </div>

        {!appReady ? (
          <LockedPanel
            title="Qualify a repository to preview PR templates"
            message="Once the repository binding is ready, Rorca previews templates with the latest local spec/run data when available and falls back to sample data otherwise."
          />
        ) : !prTemplateLoaded ? (
          /* Loading skeleton */
          <div className="space-y-2 mb-3" aria-busy="true" aria-label="Loading PR template">
            {[80, 60, 90, 70, 50].map((w, i) => (
              <div
                key={i}
                className="h-3 rounded bg-border animate-pulse"
                style={{ width: `${w}%` }}
              />
            ))}
          </div>
        ) : (
          <div className={`${prTemplatePreviewVisible ? 'grid grid-cols-2 gap-3' : 'block'}`}>
            {/* Editor */}
            <div>
              <label className="block text-xs text-muted mb-1">Template</label>
              <textarea
                value={prTemplate}
                onChange={e => { setPrTemplate(e.target.value); setPrTemplateSaved(false); }}
                placeholder="Leave empty to use the default template"
                rows={16}
                className="w-full px-3 py-2 rounded bg-bg border border-border text-sm font-mono text-[var(--text)] focus:outline-none focus:border-accent resize-y"
              />
            </div>

            {/* Live preview */}
            {prTemplatePreviewVisible && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-muted">
                    Preview ({prTemplatePreview?.source === 'latest-run' ? 'latest run' : 'sample fallback'})
                  </label>
                </div>
                {prTemplatePreviewError && (
                  <p className="mb-1 text-[11px] text-amber-300">{prTemplatePreviewError}</p>
                )}
                {prTemplatePreview?.run && (
                  <p className="mb-1 text-[11px] text-muted">
                    Latest run: {prTemplatePreview.run.title || `Run #${prTemplatePreview.run.id}`} · {prTemplatePreview.run.storiesPassed ?? 0}/{prTemplatePreview.run.storiesTotal ?? 0} stories passed
                  </p>
                )}
                {deferredPrTemplate !== prTemplate || prTemplatePreviewLoading ? (
                  /* Skeleton while deferred/server value is stale */
                  <div className="rounded bg-bg border border-border p-3 space-y-2 h-[calc(16*1.5rem+0.5rem)] overflow-auto" aria-busy="true" aria-label="Preview loading">
                    {[90, 70, 80, 60, 75, 55, 85, 65].map((w, i) => (
                      <div key={i} className="h-3 rounded bg-border animate-pulse" style={{ width: `${w}%` }} />
                    ))}
                  </div>
                ) : (
                  <pre className="rounded bg-bg border border-border p-3 text-xs font-mono text-[var(--text)] overflow-auto whitespace-pre-wrap h-[calc(16*1.5rem+0.5rem)]">
                    {previewText}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={handleSavePrTemplate}
            disabled={prTemplateSaving || !prTemplateLoaded || !appReady}
            className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:opacity-90 disabled:cursor-not-allowed disabled:bg-border disabled:text-muted disabled:hover:opacity-100 transition-colors flex items-center gap-1.5"
          >
            {prTemplateSaving ? <Loader2 size={14} className="animate-spin" /> : null}
            {prTemplateSaved ? 'Saved!' : 'Save Template'}
          </button>
          <button
            onClick={() => { setPrTemplate(''); setPrTemplateSaved(false); }}
            disabled={!prTemplateLoaded || !appReady}
            className="px-3 py-1.5 text-sm rounded border border-border hover:bg-panel transition-colors flex items-center gap-1.5 text-muted disabled:cursor-not-allowed disabled:opacity-50"
            title="Reset to default template"
          >
            <RotateCcw size={12} />
            Reset to Default
          </button>
        </div>
      </section>


    </div>
  );
}
