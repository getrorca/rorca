/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './renderMarkdown';

function parseRenderedHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function expectNoExecutableDom(document: Document): void {
  expect(document.querySelector('script, img, svg, iframe, object, embed, style')).toBeNull();
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      expect(attribute.name).not.toMatch(/^on/i);
      if (['href', 'src', 'xlink:href', 'style'].includes(attribute.name.toLowerCase())) {
        expect(attribute.value).not.toMatch(/(?:javascript|data|vbscript)\s*:/i);
      }
    }
  }
}

describe('renderMarkdown XSS boundary', () => {
  it.each([
    '<script>globalThis.pwned = true</script>',
    '<img src=x onerror="globalThis.pwned=true">',
    '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
    '<div style="background:url(javascript:alert(1))" onclick="alert(1)">x</div>',
  ])('escapes raw HTML payload %s', (payload) => {
    const document = parseRenderedHtml(renderMarkdown(payload));
    expectNoExecutableDom(document);
    expect(document.body.textContent).toBe(payload);
  });
  it.each([
    '[click](javascript:alert(document.domain))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '[click](vbscript:msgbox(1))',
    '[click](//attacker.example/payload)',
  ])('does not create active links for unsafe destination %s', (payload) => {
    const document = parseRenderedHtml(renderMarkdown(payload));
    expectNoExecutableDom(document);
    expect(document.querySelector('a')).toBeNull();
    expect(document.body.textContent).toContain('click');
  });

  it('retains safe Markdown and escapes HTML inside code', () => {
    const codePayload = '<img src=x onerror=alert(1)>';
    const document = parseRenderedHtml(renderMarkdown([
      '# Safe heading',
      '[documentation](https://docs.example.test/guide)',
      '```html',
      codePayload,
      '```',
    ].join('\n')));
    expectNoExecutableDom(document);
    expect(document.querySelector('h1')?.textContent).toBe('Safe heading');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('https://docs.example.test/guide');
    expect(document.querySelector('code')?.textContent).toBe(codePayload);
  });
});
