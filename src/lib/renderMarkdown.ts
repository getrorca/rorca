/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * renderMarkdown.ts — Shared lightweight Markdown-to-HTML renderer.
 *
 * Converts markdown text to HTML with support for headings (h1-h4),
 * code blocks (fenced with language), inline code, bold, italic, links,
 * unordered/ordered lists, blockquotes, horizontal rules, and paragraphs.
 *
 * Output uses CSS classes prefixed with `md-` (styled in src/styles/index.css
 * under `.skill-preview`).
 */

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMarkdown(md: string): string {
  const fencedBlocks: string[] = [];
  const inlineCode: string[] = [];
  const source = md.replace(/\r\n?/g, '\n').replace(/[\u0000\uE000-\uF8FF]/g, '\uFFFD');

  let rendered = source.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, rawLanguage: string, code: string) => {
    const language = rawLanguage.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
    const token = `\uE000RORCA_FENCED_${fencedBlocks.length}\uE001`;
    fencedBlocks.push(
      `<pre class=\"md-code-block\"><code${language ? ` class=\"language-${language}\"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`,
    );
    return token;
  });

  rendered = rendered.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `\uE000RORCA_INLINE_${inlineCode.length}\uE001`;
    inlineCode.push(`<code class=\"md-inline-code\">${escapeHtml(code)}</code>`);
    return token;
  });

  rendered = escapeHtml(rendered)
    .replace(/^#### (.+)$/gm, '<h4 class=\"md-h4\">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 class=\"md-h3\">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class=\"md-h2\">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class=\"md-h1\">$1</h1>')
    .replace(/^---$/gm, '<hr class=\"md-hr\" />')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, escapedDestination: string) => {
      const destination = escapedDestination.replace(/&amp;/g, '&');
      const relative = /^(?:#|\/(?!\/)|\.{1,2}\/)/.test(destination);
      let safe = relative;
      if (!safe) {
        try {
          const parsed = new URL(destination);
          safe = parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:';
        } catch {
          safe = false;
        }
      }
      return safe
        ? `<a class=\"md-link\" href=\"${escapeHtml(destination)}\" rel=\"noopener noreferrer\">${label}</a>`
        : `${label} (${escapedDestination})`;
    })
    .replace(/^- (.+)$/gm, '<li class=\"md-li\">$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li class=\"md-li-ordered\">$1</li>')
    .replace(/^&gt; (.+)$/gm, '<blockquote class=\"md-blockquote\">$1</blockquote>');

  rendered = rendered.replace(/\uE000RORCA_FENCED_(\d+)\uE001/g, (_match, index: string) => (
    fencedBlocks[Number(index)] ?? ''
  ));
  rendered = rendered
    .replace(/((?:<li class=\"md-li\">.*<\/li>\n?)+)/g, '<ul class=\"md-ul\">$1</ul>')
    .replace(/((?:<li class=\"md-li-ordered\">.*<\/li>\n?)+)/g, '<ol class=\"md-ol\">$1</ol>')
    .replace(/^(?!<(?:h[1-4]|pre|ul|ol|li|hr|blockquote)\b)((?!^\s*$).+)$/gm, '<p class=\"md-p\">$1</p>')
    .replace(/\uE000RORCA_INLINE_(\d+)\uE001/g, (_match, index: string) => inlineCode[Number(index)] ?? '');

  return rendered;
}
