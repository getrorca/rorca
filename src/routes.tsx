import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useCallback } from 'react';
import type { PanelId } from './components/Sidebar';
import type { SettingsTab } from './panels/SettingsPanel';

/** Valid settings sub-tabs for URL validation */
const VALID_SETTINGS_TABS: readonly SettingsTab[] = [
  'general', 'direction', 'context', 'providers', 'github', 'env-vars', 'pipeline', 'hooks', 'agents',
  'shortcuts', 'account', 'billing',
  'system',
] as const;

/**
 * Maps every PanelId to its URL path segment.
 * Hub is the index route at '/'.
 */
export const PANEL_ROUTES: Record<PanelId, string> = {
  // Index
  hub: '/',
  // Specs — consolidated panel
  specs: '/specs',
  forge: '/specs',
  queue: '/specs',
  archive: '/specs',
  marketplace: '/marketplace',
  // Pipeline
  pipeline: '/pipeline',
  worktrees: '/worktrees',
  compare: '/compare',
  // Direction
  stack: '/direction',
  'team-direction': '/team-direction',
  // Analytics — unified panel (ULT-005)
  analytics: '/analytics',
  usage: '/analytics',
  costs: '/analytics',
  models: '/analytics',
  velocity: '/analytics',
  completion: '/analytics',
  roi: '/analytics',
  finops: '/analytics',
  health: '/analytics',
  // System — now inside Settings > System tab
  'audit-log': '/settings/system',
  activity: '/settings/system',
  github: '/settings/github',
  'workspace-settings': '/settings/general',
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
  // ULT-004: RunView renders as full-width panel under Pipeline
  if (/^\/runs\/\d+/.test(pathname)) return 'pipeline';
  // Spec review slide-over resolves to hub
  if (/^\/specs\/[^/]+\/review/.test(pathname)) return 'hub';
  // ULT-005: Analytics unified panel
  if (pathname === '/analytics') return 'analytics';
  // FR-004: /settings/* nested routes all resolve to 'settings' panel
  if (/^\/settings(\/|$)/.test(pathname)) return 'settings';
  // ULT-001: Consolidated specs panel
  if (pathname === '/specs') return 'specs';
  // Legacy redirects
  if (pathname === '/forge' || pathname === '/queue' || pathname === '/archive') return 'specs';
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
  return 'general';
}
