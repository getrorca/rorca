/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsSidebar from '../SettingsSidebar';

const mocks = vi.hoisted(() => ({
  breakpoint: 'mobile' as 'mobile' | 'tablet' | 'desktop',
}));

vi.mock('../../hooks/useBreakpoint', () => ({
  useBreakpoint: () => mocks.breakpoint,
}));

vi.mock('../WorkspaceSelector', () => ({
  default: () => <div>Workspace selector</div>,
}));

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}</output>;
}

function renderSettings(path = '/settings/general') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsSidebar onNavigate={vi.fn()} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('responsive settings navigation', () => {
  beforeEach(() => {
    mocks.breakpoint = 'mobile';
  });

  it('routes every settings destination from the 390px mobile dialog and restores focus on Escape', async () => {
    const user = userEvent.setup();
    const rendered = renderSettings();
    const trigger = screen.getByRole('button', { name: 'Settings navigation' });

    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Settings navigation' });
    expect(dialog.parentElement).toBe(document.body);
    expect(rendered.container).not.toContainElement(dialog);
    expect(rendered.container).toContainElement(trigger);
    expect(dialog).toContainElement(screen.getByRole('link', { name: 'Providers & Models' }));
    expect(screen.getByRole('button', { name: 'Close settings navigation' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Settings navigation' })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    await user.click(screen.getByRole('link', { name: 'Providers & Models' }));
    expect(screen.getByRole('status', { name: 'Current route' })).toHaveTextContent('/settings/providers');
    expect(screen.queryByRole('dialog', { name: 'Settings navigation' })).not.toBeInTheDocument();
  });

  it('keeps the full settings route list usable at the canonical 1024px tablet breakpoint', async () => {
    mocks.breakpoint = 'tablet';
    const user = userEvent.setup();
    renderSettings('/settings/general');

    const trigger = screen.getByRole('button', { name: 'Settings navigation' });
    const controls = screen.getByRole('navigation', { name: 'Settings navigation controls' });
    expect(controls).toContainElement(trigger);
    expect(controls.compareDocumentPosition(screen.getByRole('status', { name: 'Current route' }))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Settings navigation' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Developer Tools' }));

    expect(screen.getByRole('status', { name: 'Current route' })).toHaveTextContent('/settings/developer');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});
