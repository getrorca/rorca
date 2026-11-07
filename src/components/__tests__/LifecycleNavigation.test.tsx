/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_ROUTES } from '../../routes';
import Sidebar, { NAV_ITEMS, NAV_SECTIONS } from '../Sidebar';
import { SidebarCollapsedContext } from '../ResizableSidebar';

const EXPERT_NAVIGATION = [
  ['specs', 'Specs', '/specs'],
  ['lifecycle', 'Lifecycle Control', '/lifecycle'],
  ['runs', 'Runs', '/runs'],
  ['execution-authority', 'Execution Authority', '/execution-authority'],
  ['marketplace', 'Marketplace', '/marketplace'],
  ['direction', 'Direction', '/direction'],
  ['settings', 'Settings', '/settings'],
] as const;

const PRIMARY_NAVIGATION = [
  ['today', 'Today', '/today'],
  ['missions', 'Missions', '/missions'],
  ['insights', 'Insights', '/insights'],
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

function renderSidebar(
  path = '/lifecycle',
  collapsed = false,
  mobileOpen = false,
  onMobileOpen: () => void = () => {},
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarCollapsedContext.Provider value={collapsed}>
        <Sidebar
          onNavigate={() => {}}
          mobileOpen={mobileOpen}
          onMobileClose={() => {}}
          onMobileOpen={onMobileOpen}
        />
      </SidebarCollapsedContext.Provider>
    </MemoryRouter>,
  );
}

function MobileSidebarHarness() {
  const [open, setOpen] = useState(false);
  return (
    <SidebarCollapsedContext.Provider value={false}>
      <Sidebar
        onNavigate={() => {}}
        mobileOpen={open}
        onMobileOpen={() => setOpen(true)}
        onMobileClose={() => setOpen(false)}
      />
    </SidebarCollapsedContext.Provider>
  );
}

beforeEach(() => { mocks.breakpoint = 'desktop'; });

describe('Lifecycle Control navigation surfaces', () => {
  it('exposes the exact label and active route on the desktop sidebar', () => {
    renderSidebar();
    const link = screen.getByRole('link', { name: 'Lifecycle Control' });
    expect(link).toHaveAttribute('href', '/lifecycle');
    expect(link.className).toContain('bg-surface-200');
    expect(screen.getByRole('link', { name: 'Specs' })).toHaveAttribute('href', '/specs');
  });

  it('keeps an accessible name in the collapsed rail', () => {
    renderSidebar('/lifecycle', true);
    expect(screen.getByRole('link', { name: 'Lifecycle Control' })).toHaveAttribute('title', 'Lifecycle Control');
  });

  it('keeps the narrow bottom bar focused on primary destinations with a persistent More entry', () => {
    mocks.breakpoint = 'mobile';
    const onMobileOpen = vi.fn();
    render(
      <MemoryRouter initialEntries={['/today']}>
        <SidebarCollapsedContext.Provider value={false}>
          <Sidebar onNavigate={() => {}} onMobileOpen={onMobileOpen} onMobileClose={() => {}} />
        </SidebarCollapsedContext.Provider>
      </MemoryRouter>,
    );
    for (const [, label, route] of PRIMARY_NAVIGATION) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', route);
    }
    expect(screen.queryByRole('link', { name: 'Lifecycle Control' })).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'More navigation' }).click();
    expect(onMobileOpen).toHaveBeenCalledOnce();
  });

  it('opens the canonical mobile navigation, closes on Escape, and restores the persistent More trigger', async () => {
    mocks.breakpoint = 'mobile';
    const user = userEvent.setup();
    render(<MemoryRouter><MobileSidebarHarness /></MemoryRouter>);
    const more = screen.getByRole('button', { name: 'More navigation' });
    await user.click(more);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close main navigation' })).toHaveFocus());
    expect(screen.getByRole('dialog', { name: 'More navigation' })).toContainElement(
      screen.getByRole('navigation', { name: 'Main navigation' }),
    );
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toHaveAttribute('id', 'mobile-main-navigation');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Close main navigation' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'More navigation' })).toHaveFocus());
  });

  it('opens the expert navigation overlay from the narrow bottom bar', () => {
    mocks.breakpoint = 'mobile';
    const onMobileOpen = vi.fn();
    renderSidebar('/lifecycle', false, false, onMobileOpen);

    fireEvent.click(screen.getByRole('button', { name: 'More navigation' }));
    expect(onMobileOpen).toHaveBeenCalledOnce();
  });

  it('keeps every expert lens reachable from the narrow mobile menu overlay', () => {
    mocks.breakpoint = 'mobile';
    renderSidebar('/lifecycle', false, true);
    expect(screen.getByRole('link', { name: 'Lifecycle Control' })).toHaveAttribute('href', '/lifecycle');
    for (const [, label, route] of EXPERT_NAVIGATION) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', route);
    }
  });

  it('keeps every primary and expert route directly reachable on the 1024px tablet rail', () => {
    mocks.breakpoint = 'tablet';
    renderSidebar('/settings/general');
    for (const [, label, route] of [...PRIMARY_NAVIGATION, ...EXPERT_NAVIGATION]) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', route);
    }
  });

  it('keeps Direction as the sole direction editor under Expert lenses', () => {
    expect(NAV_ITEMS.map(({ id, label }) => [id, label])).toEqual([
      ['today', 'Today'],
      ['missions', 'Missions'],
      ['insights', 'Insights'],
      ['specs', 'Specs'],
      ['lifecycle', 'Lifecycle Control'],
      ['runs', 'Runs'],
      ['execution-authority', 'Execution Authority'],
      ['marketplace', 'Marketplace'],
      ['direction', 'Direction'],
      ['settings', 'Settings'],
    ]);
    for (const [id, label, route] of [...PRIMARY_NAVIGATION, ...EXPERT_NAVIGATION]) {
      expect(NAV_ITEMS.find((item) => item.id === id)?.label).toBe(label);
      expect(PANEL_ROUTES[id]).toBe(route);
    }

    const primaryItems = NAV_ITEMS.slice(0, PRIMARY_NAVIGATION.length);
    const directionItem = NAV_ITEMS.find((item) => item.id === 'direction');
    const primarySection = NAV_SECTIONS.find((section) => section.id === 'primary');
    const expertSection = NAV_SECTIONS.find((section) => section.id === 'expert');
    expect(primarySection?.items.map((item) => item.id)).toEqual(['today', 'missions', 'insights']);
    expect(expertSection?.items.find((item) => item.id === 'direction')).toMatchObject({ id: 'direction', label: 'Direction' });
    expect(primaryItems.some((item) => item.label === 'Knowledge')).toBe(false);
    expect(directionItem).toMatchObject({ id: 'direction', label: 'Direction' });
  });

  it('feeds the command palette from the same canonical label', () => {
    const lifecycleItem = NAV_ITEMS.find((item) => item.id === 'lifecycle');
    expect(lifecycleItem?.label).toBe('Lifecycle Control');
    expect(lifecycleItem?.icon).toBeTruthy();
    expect(NAV_ITEMS.find((item) => item.id === 'specs')?.label).toBe('Specs');
  });
});
