/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import LifecycleMarkdown from '../LifecycleMarkdown';

describe('LifecycleMarkdown', () => {
  it('renders GFM semantics and suppresses raw HTML', () => {
    render(<LifecycleMarkdown content={`# Delivery contract

- One
- Two

| Rule | State |
| --- | --- |
| Isolation | Required |

~~obsolete~~

<script>window.compromised = true</script>`} />);

    expect(screen.getByRole('heading', { name: 'Delivery contract' })).toBeInTheDocument();
    expect(screen.getByRole('list')).toHaveTextContent('One');
    expect(screen.getByRole('region', { name: 'Scrollable table' })).toHaveTextContent('IsolationRequired');
    expect(screen.getByText('obsolete')).toHaveStyle({ textDecoration: 'line-through' });
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByText(/compromised/)).not.toBeInTheDocument();
  });

  it('copies fenced code and opens external links safely', async () => {
    const user = userEvent.setup();
    render(<LifecycleMarkdown content={'```ts\nconst safe = true;\n```\n\n[Docs](https://example.com/docs)'} />);

    const copy = screen.getByRole('button', { name: 'Copy code' });
    await user.click(copy);
    expect(await navigator.clipboard.readText()).toBe('const safe = true;');
    expect(copy).toHaveAccessibleName('Code copied');

    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    expect(within(copy.parentElement as HTMLElement).getByText('const safe = true;')).toBeInTheDocument();
  });
});
