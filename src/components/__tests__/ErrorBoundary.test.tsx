/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from '../ErrorBoundary';

let shouldThrow = true;

function FlakyPanel() {
  if (shouldThrow) throw new Error('Lifecycle render failed');
  return <p>Lifecycle recovered</p>;
}

describe('ErrorBoundary recovery semantics', () => {
  beforeEach(() => {
    shouldThrow = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('announces and focuses a fatal replacement with an incident reference and recovery routes', async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary label="Lifecycle Control">
        <FlakyPanel />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    const heading = screen.getByRole('heading', { name: 'Something went wrong' });
    expect(alert).toHaveAccessibleName('Something went wrong');
    await waitFor(() => expect(heading).toHaveFocus());
    expect(alert).toHaveTextContent(/Incident reference: UI-/);
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('link', { name: 'Return to Today' })).toHaveAttribute('href', '/today');

    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('Lifecycle recovered')).toBeInTheDocument();
  });
});
