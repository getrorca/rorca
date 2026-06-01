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
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderMarkdown(md: string): string {
  return md
    // Code blocks (fenced)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) =>
      `<pre class="md-code-block"><code class="language-${lang}">${escapeHtml(code.trim())}</code></pre>`)
    // Headings
    .replace(/^#### (.+)$/gm, '<h4 class="md-h4">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr class="md-hr" />')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
    // Unordered lists
    .replace(/^- (.+)$/gm, '<li class="md-li">$1</li>')
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li class="md-li-ordered">$1</li>')
    // Paragraphs (wrap lines that aren't already HTML)
    .replace(/^(?!<[a-z])((?!^\s*$).+)$/gm, '<p class="md-p">$1</p>')
    // Clean up consecutive <li> items into <ul>
    .replace(/((?:<li class="md-li">.*<\/li>\n?)+)/g, '<ul class="md-ul">$1</ul>')
    .replace(/((?:<li class="md-li-ordered">.*<\/li>\n?)+)/g, '<ol class="md-ol">$1</ol>');
}
