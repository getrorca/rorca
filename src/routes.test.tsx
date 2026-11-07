/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  PANEL_ROUTES,
  ValidSettingsTabRoute,
  isValidSettingsTab,
  pathToPanelId,
  safeInternalReturnTo,
  useAppNavigate,
} from './routes';

function NavigationHarness() {
  const location = useLocation();
  const navigatePanel = useAppNavigate();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="location">{location.pathname}{location.search}</output>
      <button type="button" onClick={() => navigatePanel('lifecycle')}>Lifecycle</button>
      <button type="button" onClick={() => navigatePanel('specs')}>Specs</button>
      <button type="button" onClick={() => navigate(-1)}>Back</button>
      <button type="button" onClick={() => navigate(1)}>Forward</button>
    </>
  );
}
function SettingsRouteHarness() {
  const location = useLocation();
  return (
    <>
      <output aria-label="settings-location">{location.pathname}</output>
      <Routes>
        <Route
          path="/settings/:tab"
          element={
            <ValidSettingsTabRoute>
              <div>Settings content</div>
            </ValidSettingsTabRoute>
          }
        />
      </Routes>
    </>
  );
}


describe('panel routing', () => {
  it('maps Lifecycle Control and the governed Mission Control route without changing existing panel routes', () => {
    expect(PANEL_ROUTES.lifecycle).toBe('/lifecycle');
    expect(pathToPanelId('/lifecycle')).toBe('lifecycle');
    expect(PANEL_ROUTES['mission-control']).toBe('/mission-control');
    expect(pathToPanelId('/mission-control')).toBe('mission-control');
    expect(PANEL_ROUTES.specs).toBe('/specs');
    expect(pathToPanelId('/specs')).toBe('specs');
    expect(pathToPanelId('/runs/42')).toBe('runs');
    expect(pathToPanelId('/specs/a-spec/review')).toBe('specs');
    expect(pathToPanelId('/workspaces/ws-1/runs/42')).toBe('runs');
    expect(pathToPanelId('/workspaces/ws-1/specs/a-spec/review')).toBe('specs');
    expect(pathToPanelId('/workspaces/ws-1/specs/a-spec/lifecycle/phases/qa')).toBe('lifecycle');
    expect(pathToPanelId('/workspaces/ws-1')).toBe('settings');
    expect('knowledge' in PANEL_ROUTES).toBe(false);
    expect(pathToPanelId('/knowledge')).toBe('today');
  });

  it('accepts only internal return links and preserves the lifecycle phase deep link', () => {
    expect(safeInternalReturnTo('?returnTo=%2Flifecycle%3Fspec%3Da%26phase%3Dtesting', '/runs')).toBe('/lifecycle?spec=a&phase=testing');
    expect(safeInternalReturnTo('?returnTo=https%3A%2F%2Fevil.example', '/runs')).toBe('/runs');
    expect(safeInternalReturnTo('?returnTo=%2F%2Fevil.example', '/specs')).toBe('/specs');
  });

  it('preserves direct deep-link query state and browser back-forward history', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/lifecycle?spec=release-a&phase=testing']}>
        <NavigationHarness />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('location')).toHaveTextContent('/lifecycle?spec=release-a&phase=testing');
    await user.click(screen.getByRole('button', { name: 'Specs' }));
    expect(screen.getByLabelText('location')).toHaveTextContent('/specs');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('location')).toHaveTextContent('/lifecycle?spec=release-a&phase=testing');
    await user.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.getByLabelText('location')).toHaveTextContent('/specs');
  });
  it('recognizes PTY recovery while rejecting phantom integration settings routes', () => {
    expect(isValidSettingsTab('pty-recovery')).toBe(true);
    expect(isValidSettingsTab('github')).toBe(true);
    expect(isValidSettingsTab('integrations')).toBe(false);
    expect(isValidSettingsTab('integration-health')).toBe(false);
    expect(isValidSettingsTab('audit')).toBe(false);
  });

  it('renders the direct PTY recovery settings route without falling back', () => {
    render(
      <MemoryRouter initialEntries={['/settings/pty-recovery']}>
        <SettingsRouteHarness />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('settings-location')).toHaveTextContent('/settings/pty-recovery');
    expect(screen.getByText('Settings content')).toBeInTheDocument();
  });

  it('replace-redirects invalid settings URLs to General', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/integrations']}>
        <SettingsRouteHarness />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('settings-location')).toHaveTextContent('/settings/general');
    });
    expect(screen.getByText('Settings content')).toBeInTheDocument();
  });

});
