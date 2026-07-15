/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

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
  // FinOps group
  'finops',
  // System group
  'shortcuts', 'system', 'developer',
] as const;

/**
 * Maps every PanelId to its URL path segment.
 * ULT-022: primary panels + run-view + spec-review.
 */
export const PANEL_ROUTES: Record<PanelId, string> = {
  specs: '/specs',
  lifecycle: '/lifecycle',
  runs: '/runs',
  analytics: '/analytics',
  direction: '/direction',
  settings: '/settings',
  marketplace: '/marketplace',
  'run-view': '/runs',
  'spec-review': '/specs',
};

/** Accept only same-origin app paths for drill-down return links. */
export function safeInternalReturnTo(search: string, fallback: string): string {
  const value = new URLSearchParams(search).get('returnTo');
  return value && value.startsWith('/') && !value.startsWith('//') ? value : fallback;
}

/** Resolve current URL path to a PanelId. Returns 'specs' for unknown paths. */
export function pathToPanelId(pathname: string): PanelId {
  if (/^\/runs\/\d+/.test(pathname)) return 'runs';
  if (/^\/specs\/[^/]+\/review/.test(pathname)) return 'specs';
  if (pathname === '/analytics') return 'analytics';
  if (pathname === '/lifecycle') return 'lifecycle';
  if (/^\/settings(\/|$)/.test(pathname)) return 'settings';
  if (pathname === '/specs') return 'specs';
  if (pathname === '/runs') return 'runs';
  if (pathname === '/direction') return 'direction';
  if (pathname === '/marketplace') return 'marketplace';
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
