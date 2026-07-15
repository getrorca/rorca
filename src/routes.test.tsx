/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PANEL_ROUTES, pathToPanelId, safeInternalReturnTo, useAppNavigate } from './routes';

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

describe('panel routing', () => {
  it('maps Lifecycle Control without changing existing panel routes', () => {
    expect(PANEL_ROUTES.lifecycle).toBe('/lifecycle');
    expect(pathToPanelId('/lifecycle')).toBe('lifecycle');
    expect(PANEL_ROUTES.specs).toBe('/specs');
    expect(pathToPanelId('/specs')).toBe('specs');
    expect(pathToPanelId('/runs/42')).toBe('runs');
    expect(pathToPanelId('/specs/a-spec/review')).toBe('specs');
  });

  it('accepts only internal return links and preserves the lifecycle phase deep link', () => {
    expect(safeInternalReturnTo('?returnTo=%2Flifecycle%3Fspec%3Da%26phase%3Dqa', '/runs')).toBe('/lifecycle?spec=a&phase=qa');
    expect(safeInternalReturnTo('?returnTo=https%3A%2F%2Fevil.example', '/runs')).toBe('/runs');
    expect(safeInternalReturnTo('?returnTo=%2F%2Fevil.example', '/specs')).toBe('/specs');
  });

  it('preserves direct deep-link query state and browser back-forward history', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/lifecycle?spec=release-a&phase=qa']}>
        <NavigationHarness />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('location')).toHaveTextContent('/lifecycle?spec=release-a&phase=qa');
    await user.click(screen.getByRole('button', { name: 'Specs' }));
    expect(screen.getByLabelText('location')).toHaveTextContent('/specs');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('location')).toHaveTextContent('/lifecycle?spec=release-a&phase=qa');
    await user.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.getByLabelText('location')).toHaveTextContent('/specs');
  });
});
