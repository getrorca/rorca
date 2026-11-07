/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ULT-021: Accessibility test helpers using axe-core.
 * Usage: import { testA11y } from '../test/a11y-helpers';
 *        await testA11y(container);
 */
import axeCore from 'axe-core';
import { expect } from 'vitest';

/**
 * Runs axe-core accessibility audit on a rendered container.
 * Asserts zero violations (WCAG 2.1 AA).
 * Ignores color-contrast (jsdom cannot compute) and region (test fragments).
 *
 * @example
 * const { container } = render(<MyComponent />);
 * await testA11y(container);
 */
export async function testA11y(container: HTMLElement): Promise<void> {
  const results = await axeCore.run(container, {
    rules: {
      // jsdom cannot compute visual styles — skip color-contrast checks
      // (contrast is validated via design tokens in tokens.css)
      'color-contrast': { enabled: false },
      // Landmark regions are optional within test fragments
      region: { enabled: false },
    },
  });

  const violations = results.violations;
  if (violations.length > 0) {
    const messages = violations.map((v: import('axe-core').Result) => {
      const nodes = v.nodes.map((n: import('axe-core').NodeResult) => `  - ${n.html}`).join('\n');
      return `[${v.impact}] ${v.id}: ${v.help}\n${nodes}`;
    });
    expect.fail(
      `Expected zero axe violations but found ${violations.length}:\n\n${messages.join('\n\n')}`,
    );
  }
}
