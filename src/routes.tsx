/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Navigate, useNavigate, useLocation, useParams } from 'react-router';
import { useCallback, type ReactElement } from 'react';
import type { PanelId } from './components/Sidebar';
import type { SettingsTab } from './panels/SettingsPanel';
import { consumeReturnContext, createReturnContext } from './lib/returnContext';

/** Valid settings sub-tabs for URL validation */
export const VALID_SETTINGS_TABS: readonly SettingsTab[] = [
  // Workspace group
  'general', 'env-vars', 'hooks', 'agents', 'context', 'github',
  // Execution group
  'providers', 'direction', 'pipeline', 'pty-recovery',
  // FinOps group
  'finops',
  // System group
  'shortcuts', 'system', 'developer',
] as const;

export function isValidSettingsTab(tab: string | undefined): tab is SettingsTab {
  return !!tab && (VALID_SETTINGS_TABS as readonly string[]).includes(tab);
}
export function ValidSettingsTabRoute({ children }: { children: ReactElement }) {
  const { tab } = useParams<{ tab: string }>();
  if (!isValidSettingsTab(tab)) {
    return <Navigate to="/settings/general" replace />;
  }
  return children;
}


/**
 * Maps every PanelId to its URL path segment.
 * Mission OS primary IA + expert/system lenses + run-view + spec-review.
 */
export const PANEL_ROUTES: Record<PanelId, string> = {
  today: '/today',
  missions: '/missions',
  insights: '/insights',
  specs: '/specs',
  lifecycle: '/lifecycle',
  runs: '/runs',
  'execution-authority': '/execution-authority',
  'mission-control': '/mission-control',
  direction: '/direction',
  settings: '/settings',
  marketplace: '/marketplace',
  'run-view': '/runs',
  'spec-review': '/specs',
};

/** Accept only same-origin app paths for drill-down return links. */
export function safeInternalReturnTo(search: string, fallback: string): string {
  const serialized = new URLSearchParams(search).get('returnTo');
  if (serialized?.startsWith('{')) return consumeReturnContext(search, fallback);
  if (!serialized) return fallback;
  const queryIndex = serialized.indexOf('?');
  const legacy = createReturnContext({
    pathname: queryIndex < 0 ? serialized : serialized.slice(0, queryIndex),
    search: queryIndex < 0 ? '' : serialized.slice(queryIndex),
  });
  return legacy ? `${legacy.path}${legacy.search ?? ''}` : fallback;
}

/** Resolve current URL path to a PanelId. Returns 'today' for unknown paths. */
export function pathToPanelId(pathname: string): PanelId {
  if (/^(?:\/workspaces\/[^/]+)?\/missions(?:\/|$)/.test(pathname)) return 'missions';
  if (/^\/delivery-cases\//.test(pathname)) return 'missions';
  if (/^(?:\/workspaces\/[^/]+)?\/runs\/[^/]+/.test(pathname)) return 'runs';
  if (/^(?:\/workspaces\/[^/]+)?\/specs\/[^/]+\/review/.test(pathname)) return 'specs';
  if (/^\/workspaces\/[^/]+\/specs\/[^/]+\/lifecycle\//.test(pathname)) return 'lifecycle';
  if (/^\/workspaces\/[^/]+\/lifecycle$/.test(pathname)) return 'lifecycle';
  if (/^\/workspaces\/[^/]+\/execution-authority$/.test(pathname)) return 'execution-authority';
  if (/^\/workspaces\/[^/]+$/.test(pathname)) return 'settings';
  if (pathname === '/today') return 'today';
  if (pathname === '/missions') return 'missions';
  if (pathname === '/insights') return 'insights';
  if (pathname === '/lifecycle') return 'lifecycle';
  if (pathname === '/mission-control') return 'mission-control';
  if (pathname === '/execution-authority') return 'execution-authority';
  if (/^\/settings(\/|$)/.test(pathname)) return 'settings';
  if (pathname === '/specs') return 'specs';
  if (pathname === '/runs') return 'runs';
  if (pathname === '/direction') return 'direction';
  if (pathname === '/marketplace') return 'marketplace';
  return 'today';
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
  if (isValidSettingsTab(tab)) {
    return tab;
  }
  return 'general';
}
