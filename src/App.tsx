import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { HelpTipsProvider } from './contexts/HelpTipsContext';
import { ToastProvider, useGlobalToast } from './contexts/ToastContext';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import { NotificationProvider } from './contexts/NotificationContext';
import Shell from './components/Shell';
import Sidebar, { type PanelId } from './components/Sidebar';
import OnboardingWizard from './components/OnboardingWizard';
import CommandPalette from './components/CommandPalette';
import KeyboardShortcutsPanel from './components/KeyboardShortcutsPanel';
import ErrorBoundary from './components/ErrorBoundary';
// NetworkBanner is now inline in Shell.tsx top bar (useNetworkOffline + NetworkIndicator)
import LoginPage from './components/LoginPage';
import RegisterPage from './components/RegisterPage';
import ForgotPasswordPage from './components/ForgotPasswordPage';
import ResetPasswordPage from './components/ResetPasswordPage';
import EmailVerificationBanner from './components/EmailVerificationBanner';
import { useHotkeys, type HotkeyBinding } from './hooks/useHotkeys';
import { onApiFetchError } from './lib/apiFetch';
import SpecForgePanelPage from './panels/SpecForgePanelPage';
import DirectionStackPanel from './panels/DirectionStackPanel';
import ReviewQueuePanel from './panels/ReviewQueuePanel';
import PipelineMonitorPanel from './panels/PipelineMonitorPanel';
import WorktreesPanel from './panels/WorktreesPanel';
import ArchivePanel from './panels/ArchivePanel';
import CompareRunsPanel from './panels/CompareRunsPanel';
import GitHubSettingsPanel from './panels/GitHubSettingsPanel';
import ActivityFeedPanel from './panels/ActivityFeedPanel';
import TeamDirectionPanel from './panels/TeamDirectionPanel';
import TemplateMarketplacePanel from './panels/TemplateMarketplacePanel';
import UsageDashboardPanel from './panels/UsageDashboardPanel';
import CostBreakdownPanel from './panels/CostBreakdownPanel';
import ModelComparisonPanel from './panels/ModelComparisonPanel';
import VelocityChartPanel from './panels/VelocityChartPanel';
import CompletionRatePanel from './panels/CompletionRatePanel';
import HealthDashboardPanel from './panels/HealthDashboardPanel';
import AuditLogPanel from './panels/AuditLogPanel';
import RoiCalculatorPanel from './panels/RoiCalculatorPanel';
import SettingsPanel from './panels/SettingsPanel';
import WorkspaceSettingsPanel from './panels/WorkspaceSettingsPanel';

type AuthPage = 'login' | 'register' | 'forgot-password' | 'reset-password';

function AuthGate() {
  const { isAuthenticated, loading } = useAuth();
  const [authPage, setAuthPage] = useState<AuthPage>(() => {
    // Check if landing on /reset-password with a token
    if (window.location.pathname === '/reset-password') return 'reset-password';
    return 'login';
  });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="text-muted text-sm">Loading...</div>
      </div>
    );
  }

  // Handle /reset-password route — show reset page even when auth is bypassed
  if (authPage === 'reset-password') {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    if (!token) {
      // No token provided — go to forgot password
      return <ForgotPasswordPage onSwitchToLogin={() => { window.history.replaceState(null, '', '/'); setAuthPage('login'); }} />;
    }
    return (
      <ResetPasswordPage
        token={token}
        onSwitchToLogin={() => { window.history.replaceState(null, '', '/'); setAuthPage('login'); }}
      />
    );
  }

  // Auth gate bypassed — Rorca is a local single-user tool, login wall not needed yet
  void isAuthenticated; void authPage; void setAuthPage;

  return (
    <NotificationProvider>
      <WorkspaceProvider>
        <AppContent />
      </WorkspaceProvider>
    </NotificationProvider>
  );
}

/** Subscribes to apiFetch error events and unhandled rejections, shows toasts */
function GlobalErrorWiring() {
  const { show } = useGlobalToast();

  // Track recent messages to avoid duplicate toasts (apiFetch errors + unhandled rejections)
  const recentRef = useRef(new Set<string>());

  const showDeduped = useCallback((message: string) => {
    const key = message.slice(0, 100);
    if (recentRef.current.has(key)) return;
    recentRef.current.add(key);
    setTimeout(() => recentRef.current.delete(key), 2000);
    show(message, 'error');
  }, [show]);

  // API fetch errors → toast
  useEffect(() => {
    return onApiFetchError((message) => {
      showDeduped(message);
    });
  }, [showDeduped]);

  // Unhandled promise rejections → toast
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

/** Renders the active panel component */
function ActivePanel({ id, onNavigate }: { id: PanelId; onNavigate: (p: PanelId) => void }) {
  switch (id) {
    case 'forge': return <SpecForgePanelPage />;
    case 'stack': return <DirectionStackPanel />;
    case 'team-direction': return <TeamDirectionPanel />;
    case 'queue': return <ReviewQueuePanel />;
    case 'pipeline': return <PipelineMonitorPanel />;
    case 'worktrees': return <WorktreesPanel />;
    case 'compare': return <CompareRunsPanel onBack={() => onNavigate('pipeline')} />;
    case 'archive': return <ArchivePanel onNavigate={onNavigate} />;
    case 'marketplace': return <TemplateMarketplacePanel />;
    case 'usage': return <UsageDashboardPanel />;
    case 'costs': return <CostBreakdownPanel />;
    case 'models': return <ModelComparisonPanel />;
    case 'velocity': return <VelocityChartPanel />;
    case 'completion': return <CompletionRatePanel />;
    case 'roi': return <RoiCalculatorPanel />;
    case 'health': return <HealthDashboardPanel />;
    case 'audit-log': return <AuditLogPanel />;
    case 'activity': return <ActivityFeedPanel />;
    case 'github': return <GitHubSettingsPanel />;
    case 'workspace-settings': return <WorkspaceSettingsPanel />;
    case 'settings': return <SettingsPanel />;
    default: return null;
  }
}

/** Panel label for ErrorBoundary fallback */
const PANEL_LABELS: Record<PanelId, string> = {
  forge: 'Spec Forge',
  stack: 'Direction Stack',
  'team-direction': 'Team Direction',
  queue: 'Review Queue',
  pipeline: 'Pipeline Monitor',
  worktrees: 'Worktree Manager',
  compare: 'Compare Runs',
  archive: 'Archive',
  marketplace: 'Template Marketplace',
  usage: 'Token Usage',
  costs: 'Cost Breakdown',
  models: 'Model Comparison',
  velocity: 'Velocity Chart',
  completion: 'Completion Rates',
  roi: 'ROI Calculator',
  health: 'Health Dashboard',
  'audit-log': 'Audit Log',
  activity: 'Activity Feed',
  github: 'GitHub Settings',
  'workspace-settings': 'Workspace Settings',
  settings: 'Settings',
};

function AppContent() {
  const [activePanel, setActivePanel] = useState<PanelId>('forge');
  const { workspaces } = useWorkspace();
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Global keyboard shortcuts via useHotkeys
  const hotkeys = useMemo<HotkeyBinding[]>(() => [
    { key: 'mod+k', handler: () => setShowCommandPalette((prev) => !prev) },
    { key: '?', handler: () => setShowShortcuts((prev) => !prev) },
    { key: 'mod+/', handler: () => setShowShortcuts((prev) => !prev) },
    // Navigation: Cmd+1..5 for top panels
    { key: 'mod+1', handler: () => setActivePanel('forge') },
    { key: 'mod+2', handler: () => setActivePanel('stack') },
    { key: 'mod+3', handler: () => setActivePanel('queue') },
    { key: 'mod+4', handler: () => setActivePanel('pipeline') },
    { key: 'mod+5', handler: () => setActivePanel('archive') },
    // Spec actions
    { key: 'mod+n', handler: () => setActivePanel('forge') },
    // Pipeline actions
    { key: 'mod+shift+r', handler: () => setActivePanel('pipeline') },
  ], []);

  useHotkeys(hotkeys);

  if (workspaces.length === 0) {
    return (
      <Shell>
        <OnboardingWizard />
      </Shell>
    );
  }

  return (
    <Shell
      sidebar={<Sidebar activePanel={activePanel} onNavigate={setActivePanel} mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />}
      showMenuButton
      onMenuToggle={() => setMobileNavOpen((v) => !v)}
      onNavigate={setActivePanel}
    >
      <EmailVerificationBanner />
      {/* key={activePanel} resets ErrorBoundary when switching panels */}
      <ErrorBoundary key={activePanel} label={PANEL_LABELS[activePanel]}>
        <ActivePanel id={activePanel} onNavigate={setActivePanel} />
      </ErrorBoundary>
      {showCommandPalette && (
        <CommandPalette
          onNavigate={setActivePanel}
          onClose={() => setShowCommandPalette(false)}
        />
      )}
      {showShortcuts && (
        <KeyboardShortcutsPanel onClose={() => setShowShortcuts(false)} />
      )}
    </Shell>
  );
}

function App() {
  return (
    <ThemeProvider>
      <HelpTipsProvider>
        <ToastProvider>
          <AuthProvider>
            <GlobalErrorWiring />
            <AuthGate />
          </AuthProvider>
        </ToastProvider>
      </HelpTipsProvider>
    </ThemeProvider>
  );
}

export default App;
