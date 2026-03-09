import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useCallback } from 'react';
import type { PanelId } from './components/Sidebar';
import type { SettingsTab } from './panels/SettingsPanel';

/** Valid settings sub-tabs for URL validation */
const VALID_SETTINGS_TABS: readonly SettingsTab[] = [
  // Workspace group
  'general', 'env-vars', 'hooks', 'agents', 'context',
  // Execution group
  'providers', 'direction', 'pipeline',
  // Integrations group
  'github', 'slack', 'linear', 'vercel',
  // Account group
  'account', 'billing', 'shortcuts', 'notifications',
  // System group
  'system', 'api-keys', 'developer',
] as const;

/**
 * Maps every PanelId to its URL path segment.
 * ULT-006: 5 primary panels — Specs, Runs, Analytics, Direction, Settings.
 * All legacy PanelIds redirect to their new primary panel.
 */
export const PANEL_ROUTES: Record<PanelId, string> = {
  // ULT-006: Primary panels
  specs: '/specs',
  runs: '/runs',
  analytics: '/analytics',
  direction: '/direction',
  settings: '/settings',

  // Run sub-view
  'run-view': '/runs',

  // Legacy aliases — all redirect to their parent primary panel
  hub: '/runs',                    // Hub merged into Runs
  forge: '/specs',
  queue: '/specs',
  archive: '/specs',
  marketplace: '/specs',           // Marketplace merged into Specs as tab
  pipeline: '/runs',               // Pipeline → Runs
  worktrees: '/runs',              // Worktrees only in RunView
  compare: '/runs',                // Compare only from RunView
  stack: '/direction',             // stack → direction
  'team-direction': '/direction',
  memory: '/direction',            // Memory → Direction tab
  // Analytics legacy
  usage: '/analytics',
  costs: '/analytics',
  models: '/analytics',
  velocity: '/analytics',
  completion: '/analytics',
  roi: '/analytics',
  finops: '/analytics',
  health: '/analytics',
  // System → Settings
  'audit-log': '/settings/system',
  activity: '/settings/system',
  github: '/settings/github',
  'workspace-settings': '/settings/general',
  // Slide-over
  'spec-review': '/specs',
};

/** Resolve current URL path to a PanelId. Returns 'specs' for unknown paths. */
export function pathToPanelId(pathname: string): PanelId {
  // RunView renders as full-width panel under Runs
  if (/^\/runs\/\d+/.test(pathname)) return 'runs';
  // Spec review slide-over resolves to specs
  if (/^\/specs\/[^/]+\/review/.test(pathname)) return 'specs';
  // Analytics
  if (pathname === '/analytics') return 'analytics';
  // Settings nested routes
  if (/^\/settings(\/|$)/.test(pathname)) return 'settings';
  // Specs
  if (pathname === '/specs') return 'specs';
  // Runs
  if (pathname === '/runs') return 'runs';
  // Direction
  if (pathname === '/direction') return 'direction';
  // Legacy redirects
  if (pathname === '/forge' || pathname === '/queue' || pathname === '/archive' || pathname === '/marketplace') return 'specs';
  if (pathname === '/pipeline' || pathname === '/worktrees' || pathname === '/compare') return 'runs';
  if (pathname === '/memory' || pathname === '/team-direction') return 'direction';
  if (pathname === '/' || pathname === '') return 'specs';
  return 'specs';
}

/**
 * Hook that provides router-based navigation with the same
 * `(panel: PanelId) => void` signature used throughout the app.
 */
export function useAppNavigate() {
  const navigate = useNavigate();

  const navigateTo = useCallback(
    (panel: PanelId) => {
      navigate(PANEL_ROUTES[panel] ?? '/specs');
    },
    [navigate],
  );

  return navigateTo;
}

/**
 * Hook that returns the current PanelId based on the URL path.
 */
export function useActivePanel(): PanelId {
  const location = useLocation();
  return pathToPanelId(location.pathname);
}

/**
 * FR-004: Derive the active settings tab from the route param.
 * Must be used inside a route with a :tab param (e.g. /settings/:tab).
 * Returns 'general' as fallback for invalid/missing tab.
 */
export function useActiveSettingsTab(): SettingsTab {
  const { tab } = useParams<{ tab: string }>();
  if (tab && (VALID_SETTINGS_TABS as readonly string[]).includes(tab)) {
    return tab as SettingsTab;
  }
  return 'general';
}
