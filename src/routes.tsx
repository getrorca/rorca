import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useCallback } from 'react';
import type { PanelId } from './components/Sidebar';
import type { SettingsTab } from './panels/SettingsPanel';

/** Valid settings sub-tabs for URL validation */
const VALID_SETTINGS_TABS: readonly SettingsTab[] = ['direction', 'providers', 'github', 'personas', 'shortcuts', 'account', 'billing', 'analytics'] as const;

/**
 * Maps every PanelId to its URL path segment.
 * Hub is the index route at '/'.
 */
export const PANEL_ROUTES: Record<PanelId, string> = {
  // Index
  hub: '/',
  // Specs
  forge: '/forge',
  queue: '/forge',
  archive: '/archive',
  marketplace: '/marketplace',
  // Pipeline
  pipeline: '/pipeline',
  worktrees: '/worktrees',
  compare: '/compare',
  // Direction
  stack: '/direction',
  'team-direction': '/team-direction',
  // Analytics
  usage: '/usage',
  costs: '/costs',
  models: '/models',
  velocity: '/velocity',
  completion: '/completion',
  roi: '/roi',
  finops: '/finops',
  health: '/health',
  // System
  'audit-log': '/audit-log',
  activity: '/activity',
  github: '/github',
  'workspace-settings': '/workspace-settings',
  settings: '/settings',
  // CIE-005: Memory Ledger
  memory: '/memory',
  // Slide-over (also proper nested routes now)
  'spec-review': '/specs',
};

/** Reverse lookup: URL path → PanelId */
const PATH_TO_PANEL: Record<string, PanelId> = {};
for (const [panel, path] of Object.entries(PANEL_ROUTES)) {
  PATH_TO_PANEL[path] = panel as PanelId;
}

/** Resolve current URL path to a PanelId. Returns 'hub' for unknown paths. */
export function pathToPanelId(pathname: string): PanelId {
  // Nested slide-over routes resolve to the underlying panel
  if (/^\/runs\/\d+/.test(pathname)) return 'hub';
  if (/^\/specs\/[^/]+\/review/.test(pathname)) return 'hub';
  // FR-004: /settings/* nested routes all resolve to 'settings' panel
  if (/^\/settings(\/|$)/.test(pathname)) return 'settings';
  return PATH_TO_PANEL[pathname] ?? 'hub';
}

/**
 * Hook that provides router-based navigation with the same
 * `(panel: PanelId) => void` signature used throughout the app.
 */
export function useAppNavigate() {
  const navigate = useNavigate();

  const navigateTo = useCallback(
    (panel: PanelId) => {
      navigate(PANEL_ROUTES[panel] ?? '/');
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
 * Returns 'direction' as fallback for invalid/missing tab.
 */
export function useActiveSettingsTab(): SettingsTab {
  const { tab } = useParams<{ tab: string }>();
  if (tab && (VALID_SETTINGS_TABS as readonly string[]).includes(tab)) {
    return tab as SettingsTab;
  }
  return 'account';
}
