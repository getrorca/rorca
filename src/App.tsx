/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useMemo, useEffect, useRef, useCallback, Suspense, lazy, type ReactElement } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation, useNavigate as useRouterNavigate, useParams } from 'react-router';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { HelpTipsProvider } from './contexts/HelpTipsContext';
import { ToastProvider, useGlobalToast } from './contexts/ToastContext';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { CapabilitiesProvider } from './contexts/CapabilitiesContext';
import Shell from './components/Shell';
import RequireAuth from './components/RequireAuth';
import Sidebar, { type PanelId } from './components/Sidebar';
import SettingsSidebar from './components/SettingsSidebar';
import ResizableSidebar from './components/ResizableSidebar';
import ErrorBoundary from './components/ErrorBoundary';
import EmailVerificationBanner from './components/EmailVerificationBanner';
import WorkspaceBootstrapBanner from './components/WorkspaceBootstrapBanner';
import WorkspaceSelector from './components/WorkspaceSelector';
import { useHotkeys, type HotkeyBinding } from './hooks/useHotkeys';
import { useBreakpoint } from './hooks/useBreakpoint';
import { apiFetch, onApiFetchError } from './lib/apiFetch';
import { getBountyFeaturePolicy } from './api/bountyMissionControl';
import { getWorkspaceAttention } from './api/mission';
import {
  BoardSkeleton,
  LifecycleMatrixSkeleton,
  ListSkeleton,
  AnalyticsSkeleton,
  DirectionSkeleton,
  RunViewSkeleton,
  SettingsFormSkeleton,
} from './components/skeletons';
import SlideOver from './components/SlideOver';
import { useFileWatchSSE } from './hooks/useFileWatchSSE';
import { usePipelineRuns } from './hooks/usePipelineRuns';
import { ValidSettingsTabRoute, useAppNavigate, useActivePanel } from './routes';
import { consumeReturnContext, withReturnContext } from './lib/returnContext';
import { entityRoute, parseEntityRoute } from './lib/entityRoutes';
import { MISSION_CONTRACT_VERSIONS, type EntityRefV1 } from '../shared/contracts/mission';

// — Lazy-loaded pages (not part of initial bundle) —
const PublicReviewPage = lazy(() => import('./pages/PublicReviewPage'));
const AuthCallbackPage = lazy(() => import('./pages/auth/AuthCallbackPage'));
const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const RegisterPage = lazy(() => import('./pages/auth/RegisterPage'));
const InviteAcceptPage = lazy(() => import('./pages/InviteAcceptPage'));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'));
const OnboardingWizard = lazy(() => import('./components/OnboardingWizard'));
const CommandPalette = lazy(() => import('./components/CommandPalette'));
const KeyboardShortcutsPanel = lazy(() => import('./components/KeyboardShortcutsPanel'));

// — Lazy-loaded panel components (each gets its own chunk) —
// ULT-006: Only 5 primary panels + RunView + SpecReview + GitHubSettings
const SpecsPanel = lazy(() => import('./panels/SpecsPanel'));
const LifecyclePanel = lazy(() => import('./panels/LifecyclePanel'));
const RunsTabbedPanel = lazy(() => import('./panels/RunsTabbedPanel'));
const DirectionTabbedPanel = lazy(() => import('./panels/DirectionTabbedPanel'));
const AnalyticsPanel = lazy(() => import('./panels/AnalyticsPanel'));
const SettingsPanel = lazy(() => import('./panels/SettingsPanel'));
// GitHubSettingsPanel — now part of Settings > Integrations (loaded within SettingsPanel)
const RunViewPanel = lazy(() => import('./panels/RunViewPanel'));
const SpecReviewPanel = lazy(() => import('./panels/SpecReviewPanel'));
const MarketplacePanel = lazy(() => import('./panels/MarketplacePanel'));
const MissionControlPanel = lazy(() => import('./panels/MissionControlPanel'));
const ExecutionAuthorityPanel = lazy(() => import('./panels/ExecutionAuthorityPanel'));
// Mission OS primary surfaces
const TodayPanel = lazy(() => import('./panels/TodayPanel'));
const MissionsPanel = lazy(() => import('./panels/MissionsPanel'));
const MissionWorkspacePanel = lazy(() => import('./panels/MissionWorkspacePanel'));

// SettingsTab type — imported from SettingsPanel module
type SettingsTab = import('./panels/SettingsPanel').SettingsTab;

function PublicOnlyRoute({ children }: { children: ReactElement }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <BoardSkeleton />;
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return children;
}

/** Subscribes to apiFetch error events and unhandled rejections, shows toasts */
function GlobalErrorWiring() {
  const { show } = useGlobalToast();
  const recentRef = useRef(new Set<string>());

  const showDeduped = useCallback((message: string) => {
    const key = message.slice(0, 100);
    if (recentRef.current.has(key)) return;
    recentRef.current.add(key);
    setTimeout(() => recentRef.current.delete(key), 2000);
    show(message, 'error');
  }, [show]);

  useEffect(() => {
    return onApiFetchError((message) => {
      showDeduped(message);
    });
  }, [showDeduped]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) {
        showDeduped(detail.slice(0, 200));
      }
    };
    window.addEventListener('rorca:unhandled-error', handler);
    return () => window.removeEventListener('rorca:unhandled-error', handler);
  }, [showDeduped]);

  return null;
}

/** Panel label for ErrorBoundary fallback */
const PANEL_LABELS: Record<PanelId, string> = {
  today: 'Today',
  missions: 'Missions',
  insights: 'Insights',
  specs: 'Specs',
  lifecycle: 'Lifecycle Control',
  runs: 'Runs',
  'mission-control': 'Mission Control',
  'execution-authority': 'Execution Authority',
  direction: 'Direction',
  settings: 'Settings',
  marketplace: 'Marketplace',
  'run-view': 'Run View',
  'spec-review': 'Spec Review',
};

export function WorkspaceRouteBoundary({ children }: { children: ReactElement }) {
  const { workspaceId: routeWorkspaceId } = useParams<{ workspaceId: string }>();
  const { workspaceId, workspaces, workspacesLoading, setWorkspaceId } = useWorkspace();
  const navigate = useRouterNavigate();
  const decodedWorkspaceId = useMemo(() => {
    if (!routeWorkspaceId) return null;
    try {
      return decodeURIComponent(routeWorkspaceId);
    } catch {
      return null;
    }
  }, [routeWorkspaceId]);
  const routeWorkspaceExists = Boolean(decodedWorkspaceId && workspaces.some((workspace) => workspace.id === decodedWorkspaceId));

  useEffect(() => {
    if (workspacesLoading) return;
    if (!decodedWorkspaceId || !routeWorkspaceExists) {
      navigate('/today', { replace: true });
      return;
    }
    if (workspaceId !== decodedWorkspaceId) setWorkspaceId(decodedWorkspaceId);
  }, [decodedWorkspaceId, navigate, routeWorkspaceExists, setWorkspaceId, workspaceId, workspacesLoading]);

  if (workspacesLoading || !routeWorkspaceExists || workspaceId !== decodedWorkspaceId) return <BoardSkeleton />;
  return children;
}

function CanonicalObjectResolverRoute() {
  const location = useLocation();
  const { workspaceId } = useWorkspace();
  const entity = parseEntityRoute(`${location.pathname}${location.search}`, workspaceId);
  if (!entity) return <Navigate to="/today" replace />;
  return (
    <section className="m-6 rounded-lg border border-border bg-panel p-6" aria-labelledby="canonical-object-heading">
      <h1 id="canonical-object-heading" className="text-base font-semibold text-[var(--text)]">{entity.label}</h1>
      <p className="mt-2 text-sm text-muted">
        This exact {entity.kind} has no dedicated dashboard view. Its canonical identity is preserved here rather than opening an unrelated panel.
      </p>
      <code className="mt-4 block break-all rounded bg-bg p-3 text-xs text-[var(--text)]">{entity.kind}:{entity.id}</code>
    </section>
  );
}

/** Server href `/delivery-cases/:specId` → canonical Mission Workspace URL. */
function DeliveryCaseRedirect() {
  const { specId } = useParams<{ specId: string }>();
  const location = useLocation();
  if (!specId) return <Navigate to="/missions" replace />;
  return <Navigate to={`/missions/${encodeURIComponent(specId)}${location.search}`} replace />;
}

/** Server href `/lifecycle/specs/:specId` → Lifecycle Control query-param URL state. */
function LifecycleSpecRedirect() {
  const { specId } = useParams<{ specId: string }>();
  const location = useLocation();
  if (!specId) return <Navigate to="/lifecycle" replace />;
  const params = new URLSearchParams(location.search);
  params.set('spec', specId);
  return <Navigate to={`/lifecycle?${params.toString()}`} replace />;
}

/** Preserve bounded ReturnContextV1/search state across legacy compatibility routes. */
function SearchPreservingRedirect({ to }: { to: string }) {
  const location = useLocation();
  const source = new URLSearchParams(location.search);
  const split = to.indexOf('?');
  const pathname = split < 0 ? to : to.slice(0, split);
  const params = new URLSearchParams(split < 0 ? '' : to.slice(split + 1));
  source.forEach((value, key) => params.set(key, value));
  const search = params.toString();
  return <Navigate to={`${pathname}${search ? `?${search}` : ''}`} replace />;
}

export function WorkspaceDriftRedirect() {
  return (
    <WorkspaceRouteBoundary>
      <SearchPreservingRedirect to="/settings/direction" />
    </WorkspaceRouteBoundary>
  );
}

/** Missions landing vs. Mission Workspace, chosen by the presence of :specId. */
function MissionsRoute() {
  const { specId } = useParams<{ specId?: string }>();
  return specId ? <MissionWorkspacePanel /> : <MissionsPanel />;
}

/** Top-level route config — Shell layout wraps all panel routes */
function AppRoutes() {
  const { isAuthenticated, isLoading } = useAuth();
  const { workspacesLoading } = useWorkspace();
  const location = useLocation();

  // EQ-007: Public review page — rendered outside auth gate
  const reviewMatch = location.pathname.match(/^\/review\/([a-f0-9-]+)$/i);
  if (reviewMatch) {
    return (
      <Suspense fallback={<BoardSkeleton />}>
        <PublicReviewPage token={reviewMatch[1]} />
      </Suspense>
    );
  }

  // Auth callback route
  if (location.pathname === '/auth/callback') {
    return (
      <Suspense fallback={<BoardSkeleton />}>
        <AuthCallbackPage />
      </Suspense>
    );
  }

  if (location.pathname === '/auth/forgot-password') {
    return (
      <Suspense fallback={<BoardSkeleton />}>
        <ForgotPasswordPage />
      </Suspense>
    );
  }

  if (location.pathname === '/auth/reset-password') {
    return (
      <Suspense fallback={<BoardSkeleton />}>
        <ResetPasswordPage />
      </Suspense>
    );
  }

  if (isLoading || workspacesLoading) {
    return (
      <Shell>
        <BoardSkeleton />
      </Shell>
    );
  }

  // Public auth routes
  if (!isAuthenticated) {
    if (location.pathname === '/auth/register') {
      return (
        <Suspense fallback={<BoardSkeleton />}>
          <PublicOnlyRoute>
            <RegisterPage />
          </PublicOnlyRoute>
        </Suspense>
      );
    }

    if (location.pathname === '/auth/login') {
      return (
        <Suspense fallback={<BoardSkeleton />}>
          <PublicOnlyRoute>
            <LoginPage />
          </PublicOnlyRoute>
        </Suspense>
      );
    }

    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth/login?returnTo=${returnTo}`} replace />;
  }

  return (
    <Routes>
      <Route
        path="/auth/login"
        element={
          <PublicOnlyRoute>
            <Suspense fallback={<BoardSkeleton />}>
              <LoginPage />
            </Suspense>
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/auth/register"
        element={
          <PublicOnlyRoute>
            <Suspense fallback={<BoardSkeleton />}>
              <RegisterPage />
            </Suspense>
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/invites/:token"
        element={
          <Suspense fallback={<BoardSkeleton />}>
            <InviteAcceptPage />
          </Suspense>
        }
      />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        {/* Mission OS: Today is the default operator destination */}
        <Route index element={<Navigate to="/today" replace />} />
        <Route path="today" element={<PanelRoute panel="today" />} />
        {/* Missions — landing list + one URL-addressable delivery case per spec */}
        <Route path="missions" element={<PanelRoute panel="missions" />} />
        <Route path="missions/:specId" element={<PanelRoute panel="missions" />} />
        <Route path="missions/:specId/:lens" element={<PanelRoute panel="missions" />} />
        {/* Insights — primary lens over the existing analytics control plane */}
        <Route path="insights" element={<PanelRoute panel="insights" />} />
        {/* Server-authored href compatibility: contract paths land on canonical surfaces */}
        <Route path="delivery-cases/:specId" element={<DeliveryCaseRedirect />} />
        <Route path="lifecycle/specs/:specId" element={<LifecycleSpecRedirect />} />
        <Route path="diagnostics" element={<SearchPreservingRedirect to="/settings/system" />} />
        <Route path="context-candidates" element={<SearchPreservingRedirect to="/direction" />} />
        {/* Specs — consolidated panel (Board | List | Marketplace tabs) */}
        <Route path="specs" element={<PanelRoute panel="specs" />} />
        {/* Lifecycle Control — cross-phase delivery completeness matrix */}
        <Route path="lifecycle" element={<PanelRoute panel="lifecycle" />} />
        {/* Runs — pipeline queue + run view */}
        <Route path="runs" element={<PanelRoute panel="runs" />} />
        <Route path="execution-authority" element={<PanelRoute panel="execution-authority" />} />
        {/* Governed bounty — panel and backend both fail closed behind operator policy */}
        <Route path="mission-control" element={<PanelRoute panel="mission-control" />} />
        {/* Direction — tabbed: Direction + Team + Memory + Rules */}
        <Route path="direction" element={<PanelRoute panel="direction" />} />
        {/* Analytics — legacy duplicate of Insights; keep deep links working */}
        <Route path="analytics" element={<Navigate to="/insights" replace />} />
        <Route path="settings" element={<Navigate to="/settings/general" replace />} />
        <Route
          path="settings/:tab"
          element={
            <ValidSettingsTabRoute>
              <PanelRoute panel="settings" />
            </ValidSettingsTabRoute>
          }
        />
        <Route
          path="onboarding"
          element={
            <Suspense fallback={<BoardSkeleton />}>
              <OnboardingWizard />
            </Suspense>
          }
        />
        {/* Run view — full-width panel */}
        <Route path="runs/:runId" element={<PanelRoute panel="runs" />} />
        {/* Spec review — slide-over on top of specs */}
        <Route path="specs/:specId/review" element={<PanelRoute panel="specs" />} />
        <Route
          path="workspaces/:workspaceId"
          element={<WorkspaceRouteBoundary><PanelRoute panel="settings" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/today"
          element={<WorkspaceRouteBoundary><PanelRoute panel="today" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/missions"
          element={<WorkspaceRouteBoundary><PanelRoute panel="missions" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/missions/:specId"
          element={<WorkspaceRouteBoundary><PanelRoute panel="missions" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/missions/:specId/:lens"
          element={<WorkspaceRouteBoundary><PanelRoute panel="missions" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/drift"
          element={<WorkspaceDriftRedirect />}
        />
        <Route
          path="workspaces/:workspaceId/specs/:specId/review"
          element={<WorkspaceRouteBoundary><PanelRoute panel="specs" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/runs/:runId"
          element={<WorkspaceRouteBoundary><PanelRoute panel="runs" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/execution-authority"
          element={<WorkspaceRouteBoundary><PanelRoute panel="execution-authority" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/lifecycle"
          element={<WorkspaceRouteBoundary><PanelRoute panel="lifecycle" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/specs/:specId/lifecycle/phases/:phaseId"
          element={<WorkspaceRouteBoundary><PanelRoute panel="lifecycle" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/specs/:specId/lifecycle/evidence/:evidenceId"
          element={<WorkspaceRouteBoundary><PanelRoute panel="lifecycle" /></WorkspaceRouteBoundary>}
        />
        <Route
          path="workspaces/:workspaceId/objects/:kind/:entityId"
          element={<WorkspaceRouteBoundary><CanonicalObjectResolverRoute /></WorkspaceRouteBoundary>}
        />

        {/* Legacy redirects — all old routes redirect to new 5-panel structure */}
        <Route path="forge" element={<Navigate to="/specs" replace />} />
        <Route path="queue" element={<Navigate to="/specs" replace />} />
        <Route path="archive" element={<Navigate to="/specs" replace />} />
        {/* Marketplace — extracted from Specs panel */}
        <Route path="marketplace" element={<PanelRoute panel="marketplace" />} />
        <Route path="pipeline" element={<Navigate to="/runs" replace />} />
        <Route path="worktrees" element={<Navigate to="/runs" replace />} />
        <Route path="compare" element={<Navigate to="/runs" replace />} />
        <Route path="terminal" element={<Navigate to="/runs" replace />} />
        <Route path="team-direction" element={<Navigate to="/direction" replace />} />
        <Route path="memory" element={<Navigate to="/direction" replace />} />
        <Route path="usage" element={<Navigate to="/insights" replace />} />
        <Route path="costs" element={<Navigate to="/insights" replace />} />
        <Route path="models" element={<Navigate to="/insights" replace />} />
        <Route path="velocity" element={<Navigate to="/insights" replace />} />
        <Route path="completion" element={<Navigate to="/insights" replace />} />
        <Route path="roi" element={<Navigate to="/insights" replace />} />
        <Route path="finops" element={<Navigate to="/insights" replace />} />
        <Route path="health" element={<SearchPreservingRedirect to="/insights" />} />
        <Route path="activity" element={<Navigate to="/settings/system" replace />} />
        <Route path="github" element={<Navigate to="/settings/github" replace />} />
        <Route path="workspace-settings" element={<Navigate to="/settings/general" replace />} />

        {/* Catch-all → Today */}
        <Route path="*" element={<Navigate to="/today" replace />} />
      </Route>
    </Routes>
  );
}

/** Returns the appropriate Suspense fallback skeleton for a given panel.
 *  ULT-017: Uses shimmer-based skeletons that match each panel's final layout shape. */
function getPanelSkeleton(panel: PanelId) {
  switch (panel) {
    case 'today': case 'missions':
      return <ListSkeleton />;
    case 'insights':
      return <AnalyticsSkeleton />;
    case 'specs': case 'spec-review':
      return <BoardSkeleton />;
    case 'lifecycle':
      return <LifecycleMatrixSkeleton />;
    case 'runs': case 'execution-authority': case 'mission-control':
      return <ListSkeleton />;
    case 'run-view':
      return <RunViewSkeleton />;
    case 'direction':
      return <DirectionSkeleton />;
    case 'insights':
      return <AnalyticsSkeleton />;
    case 'settings':
      return <SettingsFormSkeleton />;
    case 'marketplace':
      return <BoardSkeleton />;
    default: return <BoardSkeleton />;
  }
}

/** Renders the correct panel component based on the panel prop */
function PanelRoute({ panel }: { panel: PanelId }) {
  const navigate = useAppNavigate();
  const { navigateToRun, forgeBrief, handleForgeBriefConsumed } = useAppContentContext();

  return (
    <ErrorBoundary key={panel} label={PANEL_LABELS[panel] || 'Panel'}>
      <Suspense fallback={getPanelSkeleton(panel)}>
        <ActivePanel
          id={panel}
          onNavigate={navigate}
          onNavigateToRun={navigateToRun}
          forgeBrief={forgeBrief}
          onForgeBriefConsumed={handleForgeBriefConsumed}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

interface ActivePanelProps {
  id: PanelId;
  onNavigate: (panel: PanelId) => void;
  onNavigateToRun: (runId: number) => void;
  forgeBrief: string | null;
  onForgeBriefConsumed: () => void;
}

function ActivePanel({ id, onNavigate, onNavigateToRun, forgeBrief, onForgeBriefConsumed }: ActivePanelProps) {
  const { activeRunId, navigateBackFromRun } = useAppContentContext();

  switch (id) {
    case 'today':
      return <TodayPanel />;

    case 'missions':
      return <MissionsRoute />;


    case 'insights':
      return <AnalyticsPanel />;

    case 'specs':
      return <SpecsPanel onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} {...(forgeBrief != null ? { initialBrief: forgeBrief, onBriefConsumed: onForgeBriefConsumed } : {})} />;

    case 'lifecycle':
      return <LifecyclePanel />;

    case 'runs':
      if (activeRunId !== null) {
        return <RunViewPanel runId={activeRunId} onBack={navigateBackFromRun} onNavigate={onNavigate} />;
      }
      return <RunsTabbedPanel onNavigate={onNavigate} onNavigateToRun={onNavigateToRun} />;

    case 'execution-authority':
      return <ExecutionAuthorityPanel />;

    case 'mission-control':
      return <MissionControlPanel />;

    case 'direction':
      return <DirectionTabbedPanel />;


    case 'settings':
      return <SettingsPanel />;

    case 'marketplace':
      return <MarketplacePanel onNavigate={onNavigate} />;

    default: return null;
  }
}

// ─── Shared context for app-level state (run view, review, forge brief, etc.) ─

import { createContext, useContext } from 'react';

interface AppContentContextValue {
  navigateToRun: (runId: number) => void;
  navigateBackFromRun: () => void;
  activeRunId: number | null;
  reviewSpecId: string | null;
  navigateToSpecReview: (specId: string) => void;
  forgeBrief: string | null;
  handleSendToForge: (brief: string) => void;
  handleForgeBriefConsumed: () => void;
  navigateToSettingsTab: (tab: SettingsTab) => void;
}

const AppContentContext = createContext<AppContentContextValue | null>(null);

function useAppContentContext(): AppContentContextValue {
  const ctx = useContext(AppContentContext);
  if (!ctx) throw new Error('useAppContentContext must be used within AppLayout');
  return ctx;
}

/** Layout route: Shell (sidebar + content area) wrapping an Outlet */
function AppLayout() {
  const activePanel = useActivePanel();
  const navigate = useAppNavigate();
  const routerNavigate = useRouterNavigate();
  const location = useLocation();
  const { workspaceId } = useWorkspace();
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showShortcutsOverlay, setShowShortcutsOverlay] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [forgeBrief, setForgeBrief] = useState<string | null>(null);
  const [pendingSpecsCount, setPendingSpecsCount] = useState(0);
  const [missionControlEnabled, setMissionControlEnabled] = useState(false);
  const breakpoint = useBreakpoint();
  const currentEntity = useMemo(
    () => parseEntityRoute(`${location.pathname}${location.search}`, workspaceId),
    [location.pathname, location.search, workspaceId],
  );
  const legacyRunMatch = location.pathname.match(/^\/runs\/(\d+)/);
  const activeRunId = currentEntity?.kind === 'run' && /^\d+$/.test(currentEntity.id)
    ? Number(currentEntity.id)
    : legacyRunMatch ? Number(legacyRunMatch[1]) : null;

  const legacySpecMatch = location.pathname.match(/^\/specs\/([^/]+)\/review/);
  const reviewSpecId = currentEntity?.kind === 'spec'
    ? currentEntity.id
    : legacySpecMatch ? decodeURIComponent(legacySpecMatch[1]) : null;

  // CIE-009: Toast on external context file changes
  useFileWatchSSE();

  // Poll pending specs count every 10s for Review Queue badge
  useEffect(() => {
    if (!workspaceId) { setPendingSpecsCount(0); return; }
    const fetchPendingCount = () => {
      const url = `/api/specs?workspaceId=${workspaceId}&status=pending`;
      apiFetch(url)
        .then((data) => setPendingSpecsCount((data as Record<string, number>).total))
        .catch(() => setPendingSpecsCount(0));
    };
    fetchPendingCount();
    const interval = setInterval(fetchPendingCount, 10_000);
    return () => clearInterval(interval);
  }, [workspaceId]);

  // Operator-owned feature policy controls visibility. Failures and disabled policy both hide the entry.
  useEffect(() => {
    let active = true;
    getBountyFeaturePolicy()
      .then((policy) => { if (active) setMissionControlEnabled(policy.enabled); })
      .catch(() => { if (active) setMissionControlEnabled(false); });
    return () => { active = false; };
  }, []);

  // ULT-004: Shared singleton poll for pipeline runs (sidebar badge)
  const { runs: pipelineRuns } = usePipelineRuns(workspaceId, 10_000);
  const activeRunCount = pipelineRuns.filter(r => r.status === 'running' || r.status === 'paused').length;

  // Mission OS: Today badge = server-ranked attention count. Strict contract
  // parse failures hide the badge rather than show a guessed count.
  const [attentionCount, setAttentionCount] = useState(0);
  useEffect(() => {
    if (!workspaceId) { setAttentionCount(0); return; }
    let cancelled = false;
    const poll = () => {
      getWorkspaceAttention(workspaceId)
        .then((data) => { if (!cancelled) setAttentionCount(data.items.length); })
        .catch(() => { if (!cancelled) setAttentionCount(0); });
    };
    poll();
    const interval = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [workspaceId]);

  const openEntity = useCallback((entity: EntityRefV1) => {
    if (!workspaceId || entity.workspaceId !== workspaceId) return;
    routerNavigate(entityRoute(entity));
  }, [routerNavigate, workspaceId]);

  const navigateToRun = useCallback((runId: number) => {
    if (!workspaceId) return;
    const destination = entityRoute({
      schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
      workspaceId,
      kind: 'run',
      id: String(runId),
      label: `Run #${runId}`,
    });
    routerNavigate(withReturnContext(destination, location, { focus: `run:${runId}`, lens: activePanel }));
  }, [activePanel, location, routerNavigate, workspaceId]);

  const navigateBackFromRun = useCallback(() => {
    routerNavigate(consumeReturnContext(location.search, '/runs', workspaceId));
  }, [location.search, routerNavigate, workspaceId]);

  const navigateBackFromSpecReview = useCallback(() => {
    routerNavigate(consumeReturnContext(location.search, '/specs', workspaceId));
  }, [location.search, routerNavigate, workspaceId]);

  const navigateToSpecReview = useCallback((specId: string) => {
    if (!workspaceId) return;
    const destination = entityRoute({
      schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
      workspaceId,
      kind: 'spec',
      id: specId,
      label: specId,
    });
    routerNavigate(withReturnContext(destination, location, { focus: `spec:${specId}`, lens: activePanel }));
  }, [activePanel, location, routerNavigate, workspaceId]);

  const handleSendToForge = useCallback((brief: string) => {
    setForgeBrief(brief);
  }, []);

  const handleForgeBriefConsumed = useCallback(() => {
    setForgeBrief(null);
  }, []);

  // Navigate to a panel — uses router
  const handleNavigate = useCallback((panel: PanelId) => {
    navigate(panel);
  }, [navigate]);

  const startOnboarding = useCallback(async () => {
    if (workspaceId) {
      try {
        await apiFetch('/api/onboarding', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentStep: 2,
            workspaceId,
            directionDone: false,
            completed: false,
          }),
        });
      } catch {
        // The routed wizard reconciles the selected workspace if persistence is unavailable.
      }
    }
    routerNavigate('/onboarding');
  }, [routerNavigate, workspaceId]);

  // FR-004: Navigate to a specific settings sub-tab via URL
  const navigateToSettingsTab = useCallback((tab: SettingsTab) => {
    routerNavigate(`/settings/${tab}`);
  }, [routerNavigate]);

  // ULT-013: Global keyboard shortcuts — 1-5 switch panels, n=new spec, ?=shortcuts overlay
  const hotkeys = useMemo<HotkeyBinding[]>(() => [
    { key: 'mod+k', handler: () => setShowCommandPalette((prev) => !prev) },
    { key: '?', handler: () => setShowShortcutsOverlay((prev) => !prev) },
    { key: 'mod+/', handler: () => setShowShortcutsOverlay((prev) => !prev) },
    // Number keys prioritize operator destinations, then the most-used expert lenses.
    { key: '1', handler: () => handleNavigate('today') },
    { key: '2', handler: () => handleNavigate('missions') },
    { key: '3', handler: () => handleNavigate('insights') },
    { key: '4', handler: () => handleNavigate('direction') },
    { key: '5', handler: () => handleNavigate('settings') },
    // n = New Mission brief (navigate to specs and trigger forge)
    { key: 'n', handler: () => { handleSendToForge(''); handleNavigate('specs'); } },
    // r = Runs expert lens
    { key: 'r', handler: () => handleNavigate('runs') },
    // Mod+1-5 also works
    { key: 'mod+1', handler: () => handleNavigate('today') },
    { key: 'mod+2', handler: () => handleNavigate('missions') },
    { key: 'mod+3', handler: () => handleNavigate('insights') },
    { key: 'mod+4', handler: () => handleNavigate('direction') },
    { key: 'mod+5', handler: () => handleNavigate('settings') },
    { key: 'mod+n', handler: () => handleNavigate('specs') },
    { key: 'mod+enter', handler: () => { if (activePanel !== 'specs' && activePanel !== 'spec-review') handleNavigate('specs'); } },
    { key: 'mod+backspace', handler: () => { if (activePanel !== 'specs' && activePanel !== 'spec-review') handleNavigate('specs'); } },
    { key: 'mod+shift+n', handler: () => { handleSendToForge(''); handleNavigate('specs'); } },
    // mod+shift+r intentionally removed — conflicts with browser hard refresh (Cmd+Shift+R)
    // Escape: close overlays in reverse order
    { key: 'escape', handler: () => {
      if (showCommandPalette) { setShowCommandPalette(false); return; }
      if (showShortcutsOverlay) { setShowShortcutsOverlay(false); return; }
    }, preventDefault: false },
  ], [handleNavigate, handleSendToForge, activePanel, showCommandPalette, showShortcutsOverlay]);

  useHotkeys(hotkeys);

  const contextValue = useMemo<AppContentContextValue>(() => ({
    navigateToRun,
    navigateBackFromRun,
    activeRunId,
    reviewSpecId,
    navigateToSpecReview,
    forgeBrief,
    handleSendToForge,
    handleForgeBriefConsumed,
    navigateToSettingsTab,
  }), [navigateToRun, navigateBackFromRun, activeRunId, reviewSpecId, navigateToSpecReview, forgeBrief, handleSendToForge, handleForgeBriefConsumed, navigateToSettingsTab]);

  return (
    <AppContentContext.Provider value={contextValue}>
      <Shell
        sidebar={
          <>
            <ResizableSidebar>
              {activePanel === 'settings' && breakpoint === 'desktop' ? (
                <SettingsSidebar onNavigate={handleNavigate} />
              ) : activePanel === 'settings' && breakpoint === 'tablet' ? null : (
                <Sidebar
                  onNavigate={handleNavigate}
                  mobileOpen={mobileNavOpen}
                  onMobileOpen={() => setMobileNavOpen(true)}
                  onMobileClose={() => setMobileNavOpen(false)}
                  queueCount={pendingSpecsCount}
                  activeRunCount={activeRunCount}
                  attentionCount={attentionCount}
                  missionControlEnabled={missionControlEnabled}
                />
              )}
            </ResizableSidebar>
          </>
        }
        showMenuButton={activePanel !== 'settings'}
        onMenuToggle={() => setMobileNavOpen((v) => !v)}
        onNavigate={handleNavigate}
      >
        {activePanel === 'settings' && breakpoint !== 'desktop' && (
          <SettingsSidebar onNavigate={handleNavigate} />
        )}
        <EmailVerificationBanner />
        {(!workspaceId || location.pathname === '/onboarding') && (
          <div className="md:hidden border-b border-border bg-panel px-3 py-2">
            <WorkspaceSelector onNavigateSettings={() => routerNavigate('/settings/general')} />
          </div>
        )}
        {location.pathname !== '/onboarding' && (
          <WorkspaceBootstrapBanner onSetUpNow={startOnboarding} />
        )}
        {/* Router-driven panel content */}
        <Outlet />

        {/* Slide-over Overlays */}
        <SlideOver isOpen={reviewSpecId !== null} onClose={navigateBackFromSpecReview} hideHeader={true}>
          {reviewSpecId !== null && (
            <SpecReviewPanel
              specId={reviewSpecId}
              initialTab={new URLSearchParams(location.search).get('tab') === 'lifecycle' ? 'lifecycle' : 'stories'}
              onBack={navigateBackFromSpecReview}
              onNavigate={handleNavigate}
              onNavigateToRun={navigateToRun}
            />
          )}
        </SlideOver>

        {showCommandPalette && (
          <Suspense fallback={null}>
            <CommandPalette
              onNavigate={handleNavigate}
              onClose={() => setShowCommandPalette(false)}
              activePanel={activePanel}
              activeRunId={activeRunId}
              onSendToForge={handleSendToForge}
              onOpenEntity={openEntity}
            />
          </Suspense>
        )}

        {showShortcutsOverlay && (
          <Suspense fallback={null}>
            <KeyboardShortcutsPanel onClose={() => setShowShortcutsOverlay(false)} />
          </Suspense>
        )}
      </Shell>
    </AppContentContext.Provider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <HelpTipsProvider>
        <ToastProvider>
          <AuthProvider>
            <CapabilitiesProvider>
              <WorkspaceProvider>
                <NotificationProvider>
                  <GlobalErrorWiring />
                  <AppRoutes />
                </NotificationProvider>
              </WorkspaceProvider>
            </CapabilitiesProvider>
          </AuthProvider>
        </ToastProvider>
      </HelpTipsProvider>
    </ThemeProvider>
  );
}

export default App;
