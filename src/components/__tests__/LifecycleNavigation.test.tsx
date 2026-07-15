/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar, { NAV_ITEMS } from '../Sidebar';
import { SidebarCollapsedContext } from '../ResizableSidebar';

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

  it('exposes Lifecycle Control in mobile navigation', () => {
    mocks.breakpoint = 'mobile';
    renderSidebar();
    expect(screen.getByRole('link', { name: 'Lifecycle Control' })).toHaveTextContent('Lifecycle Control');
  });

  it('feeds the command palette from the same canonical label', () => {
    const lifecycleItem = NAV_ITEMS.find((item) => item.id === 'lifecycle');
    expect(lifecycleItem?.label).toBe('Lifecycle Control');
    expect(lifecycleItem?.icon).toBeTruthy();
    expect(NAV_ITEMS.find((item) => item.id === 'specs')?.label).toBe('Specs');
  });
});
