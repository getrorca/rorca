import { useState, useMemo } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import Shell from './components/Shell';
import Sidebar, { type PanelId } from './components/Sidebar';
import OnboardingWizard from './components/OnboardingWizard';
import CommandPalette from './components/CommandPalette';
import KeyboardShortcutsPanel from './components/KeyboardShortcutsPanel';
import LoginPage from './components/LoginPage';
import RegisterPage from './components/RegisterPage';
import { useHotkeys, type HotkeyBinding } from './hooks/useHotkeys';
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

type AuthPage = 'login' | 'register';

function AuthGate() {
  const { isAuthenticated, loading } = useAuth();
  const [authPage, setAuthPage] = useState<AuthPage>('login');

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="text-muted text-sm">Loading...</div>
      </div>
    );
  }

  // Auth gate bypassed — Rorcha is a local single-user tool, login wall not needed yet
  void isAuthenticated; void authPage; void setAuthPage;

  return (
    <WorkspaceProvider>
      <AppContent />
    </WorkspaceProvider>
  );
}

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
    >
      {activePanel === 'forge'           && <SpecForgePanelPage />}
      {activePanel === 'stack'           && <DirectionStackPanel />}
      {activePanel === 'team-direction'  && <TeamDirectionPanel />}
      {activePanel === 'queue'           && <ReviewQueuePanel />}
      {activePanel === 'pipeline'  && <PipelineMonitorPanel />}
      {activePanel === 'worktrees' && <WorktreesPanel />}
      {activePanel === 'compare'   && <CompareRunsPanel onBack={() => setActivePanel('pipeline')} />}
      {activePanel === 'archive'   && <ArchivePanel onNavigate={setActivePanel} />}
      {activePanel === 'marketplace' && <TemplateMarketplacePanel />}
      {activePanel === 'usage'     && <UsageDashboardPanel />}
      {activePanel === 'costs'     && <CostBreakdownPanel />}
      {activePanel === 'models'    && <ModelComparisonPanel />}
      {activePanel === 'velocity'  && <VelocityChartPanel />}
      {activePanel === 'completion' && <CompletionRatePanel />}
      {activePanel === 'activity'  && <ActivityFeedPanel />}
      {activePanel === 'github'   && <GitHubSettingsPanel />}
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
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
