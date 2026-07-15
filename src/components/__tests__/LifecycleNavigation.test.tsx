/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_ROUTES } from '../../routes';
import Sidebar, { NAV_ITEMS } from '../Sidebar';
import { SidebarCollapsedContext } from '../ResizableSidebar';

const EXISTING_NAVIGATION = [
  ['specs', 'Specs', '/specs'],
  ['runs', 'Runs', '/runs'],
  ['marketplace', 'Marketplace', '/marketplace'],
  ['analytics', 'Analytics', '/analytics'],
  ['direction', 'Direction', '/direction'],
  ['settings', 'Settings', '/settings'],
] as const;

const mocks = vi.hoisted(() => ({ breakpoint: 'desktop' as 'desktop' | 'tablet' | 'mobile' }));

vi.mock('../../hooks/useBreakpoint', () => ({
  useBreakpoint: () => mocks.breakpoint,
}));
vi.mock('../WorkspaceSelector', () => ({ default: () => <div>Workspace</div> }));
vi.mock('../ThemeToggle', () => ({ default: () => <button type="button">Theme</button> }));
vi.mock('../NotificationBell', () => ({ default: () => <button type="button">Notifications</button> }));
vi.mock('../RorcaLogo', () => ({ default: () => <span>Rorca</span> }));
vi.mock('../Shell', () => ({ UserMenu: () => <button type="button">User</button> }));

function renderSidebar(path = '/lifecycle', collapsed = false) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarCollapsedContext.Provider value={collapsed}>
        <Sidebar onNavigate={() => {}} />
      </SidebarCollapsedContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => { mocks.breakpoint = 'desktop'; });

describe('Lifecycle Control navigation surfaces', () => {
  it('exposes the exact label and active route on the desktop sidebar', () => {
    renderSidebar();
    const link = screen.getByRole('listitem', { name: 'Lifecycle Control' });
    expect(link).toHaveAttribute('href', '/lifecycle');
    expect(link.className).toContain('bg-surface-200');
    expect(screen.getByRole('listitem', { name: 'Specs' })).toHaveAttribute('href', '/specs');
  });

  it('keeps an accessible name in the collapsed rail', () => {
    renderSidebar('/lifecycle', true);
    expect(screen.getByRole('listitem', { name: 'Lifecycle Control' })).toHaveAttribute('title', 'Lifecycle Control');
  });

  it('exposes Lifecycle Control and every pre-existing action in narrow mobile navigation', () => {
    mocks.breakpoint = 'mobile';
    renderSidebar();
    expect(screen.getByRole('link', { name: 'Lifecycle Control' })).toHaveAttribute('href', '/lifecycle');
    for (const [, label, route] of EXISTING_NAVIGATION) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', route);
    }
  });

  it('retains every pre-existing tab id, label, and route unchanged', () => {
    expect(NAV_ITEMS.map(({ id, label }) => [id, label])).toEqual([
      ['specs', 'Specs'],
      ['lifecycle', 'Lifecycle Control'],
      ['runs', 'Runs'],
      ['analytics', 'Analytics'],
      ['direction', 'Direction'],
      ['marketplace', 'Marketplace'],
      ['settings', 'Settings'],
    ]);
    for (const [id, label, route] of EXISTING_NAVIGATION) {
      expect(NAV_ITEMS.find((item) => item.id === id)?.label).toBe(label);
      expect(PANEL_ROUTES[id]).toBe(route);
    }
    expect(PANEL_ROUTES.lifecycle).toBe('/lifecycle');
  });

  it('feeds the command palette from the same canonical label', () => {
    const lifecycleItem = NAV_ITEMS.find((item) => item.id === 'lifecycle');
    expect(lifecycleItem?.label).toBe('Lifecycle Control');
    expect(lifecycleItem?.icon).toBeTruthy();
    expect(NAV_ITEMS.find((item) => item.id === 'specs')?.label).toBe('Specs');
  });
});
