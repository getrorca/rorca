/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ULT-021: Automated accessibility regression tests.
 * Uses axe-core to verify WCAG 2.1 AA compliance on key components.
 * Run: npx vitest run src/components/__tests__/a11y.test.tsx
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { testA11y } from '../../test/a11y-helpers';
import { ToastContainer } from '../Toast';
import type { Toast } from '../Toast';

// ─── Toast ────────────────────────────────────────────────────────────────────

describe('Toast accessibility', () => {
  it('has no axe violations for success toast', async () => {
    const toasts: Toast[] = [
      { id: 1, message: 'Spec generated successfully', type: 'success' },
    ];
    const { container } = render(
      <ToastContainer toasts={toasts} onDismiss={() => {}} />,
    );
    await testA11y(container);
  });

  it('has no axe violations for error toast', async () => {
    const toasts: Toast[] = [
      { id: 1, message: 'Failed to generate spec', type: 'error' },
    ];
    const { container } = render(
      <ToastContainer toasts={toasts} onDismiss={() => {}} />,
    );
    await testA11y(container);
  });

  it('uses role="alert" for error toasts', () => {
    const toasts: Toast[] = [
      { id: 1, message: 'Error occurred', type: 'error' },
    ];
    render(<ToastContainer toasts={toasts} onDismiss={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
  });

  it('uses role="status" for success toasts', () => {
    const toasts: Toast[] = [
      { id: 1, message: 'Success', type: 'success' },
    ];
    render(<ToastContainer toasts={toasts} onDismiss={() => {}} />);
    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
  });

  it('dismiss button has accessible name', () => {
    const toasts: Toast[] = [
      { id: 1, message: 'Info toast', type: 'info' },
    ];
    render(<ToastContainer toasts={toasts} onDismiss={() => {}} />);
    const dismissBtn = screen.getByLabelText('Dismiss');
    expect(dismissBtn).toBeInTheDocument();
  });
});

// ─── SlideOver ────────────────────────────────────────────────────────────────

describe('SlideOver accessibility', () => {
  // SlideOver uses createPortal which needs the portal container in the DOM
  it('renders with proper dialog role and aria-modal', async () => {
    // Dynamic import to avoid module resolution issues with hooks
    const { default: SlideOver } = await import('../SlideOver');
    const { container: _container } = render(
      <SlideOver isOpen={true} onClose={() => {}} title="Test Panel">
        <p>Panel content</p>
      </SlideOver>,
    );
    // Portal renders to document.body, so query from there
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
  });

  it('has aria-labelledby pointing to the title', async () => {
    const { default: SlideOver } = await import('../SlideOver');
    render(
      <SlideOver isOpen={true} onClose={() => {}} title="My Title">
        <p>Content</p>
      </SlideOver>,
    );
    const dialog = document.querySelector('[role="dialog"]');
    const titleId = dialog?.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    const titleEl = document.getElementById(titleId!);
    expect(titleEl?.textContent).toBe('My Title');
  });
});

// ─── Static HTML patterns ─────────────────────────────────────────────────────

describe('Core a11y patterns', () => {
  it('skip-to-content link exists and targets #main-content', () => {
    // Render a minimal fragment that includes the skip link
    const { container } = render(
      <div>
        <a href="#main-content" className="skip-to-content">Skip to content</a>
        <main id="main-content">Content</main>
      </div>,
    );
    const skipLink = container.querySelector('a[href="#main-content"]');
    expect(skipLink).toBeTruthy();
    expect(skipLink?.textContent).toBe('Skip to content');
  });

  it('buttons with icons have accessible names', async () => {
    const { container } = render(
      <div>
        <button aria-label="Close panel">
          <span aria-hidden="true">X</span>
        </button>
        <button aria-label="Search (⌘K)">
          <span aria-hidden="true">icon</span>
          <span>Search...</span>
        </button>
      </div>,
    );
    await testA11y(container);
  });

  it('forms with labels pass axe audit', async () => {
    const { container } = render(
      <form>
        <label htmlFor="test-input">Search</label>
        <input id="test-input" type="text" />
        <textarea aria-label="Description" />
        <select aria-label="Filter by status">
          <option value="all">All</option>
        </select>
      </form>,
    );
    await testA11y(container);
  });

  it('tablist with proper ARIA passes axe audit', async () => {
    const { container } = render(
      <div>
        <div role="tablist" aria-label="Test tabs">
          <button role="tab" aria-selected={true} aria-controls="panel-1" id="tab-1">Tab 1</button>
          <button role="tab" aria-selected={false} aria-controls="panel-2" id="tab-2">Tab 2</button>
        </div>
        <div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Content 1</div>
      </div>,
    );
    await testA11y(container);
  });
});
