import { useNavigate, useLocation } from 'react-router-dom';
import { useCallback } from 'react';
import type { PanelId } from './components/Sidebar';

/**
 * Maps every PanelId to its URL path segment.
 * Hub is the index route at '/'.
 */
export const PANEL_ROUTES: Record<PanelId, string> = {
  // Index
  hub: '/',
  // Specs
  forge: '/forge',
  queue: '/queue',
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
  // Slide-over only (not a real route, but needs an entry)
  'spec-review': '/spec-review',
};

/** Reverse lookup: URL path → PanelId */
const PATH_TO_PANEL: Record<string, PanelId> = {};
for (const [panel, path] of Object.entries(PANEL_ROUTES)) {
  PATH_TO_PANEL[path] = panel as PanelId;
}

/** Resolve current URL path to a PanelId. Returns 'hub' for unknown paths. */
export function pathToPanelId(pathname: string): PanelId {
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
