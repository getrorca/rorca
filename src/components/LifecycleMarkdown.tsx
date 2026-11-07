/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  isValidElement,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function MarkdownCodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const [copied, setCopied] = useState(false);
  const content = nodeText(children).replace(/\n$/, '');
  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className="lifecycle-markdown__code-shell">
      <button
        type="button"
        onClick={() => { void copy(); }}
        className="lifecycle-markdown__copy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={copied ? 'Code copied' : 'Copy code'}
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre {...props}>{children}</pre>
    </div>
  );
}

export default function LifecycleMarkdown({ content, className = '' }: { content: string; className?: string }) {
  return (
    <div className={`lifecycle-markdown ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: MarkdownCodeBlock,
          a: ({ href, children, ...props }) => {
            const external = typeof href === 'string' && /^https?:\/\//i.test(href);
            return (
              <a
                {...props}
                href={href}
                {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
              >
                {children}
              </a>
            );
          },
          table: ({ children, ...props }) => (
            <div className="lifecycle-markdown__table-scroll" tabIndex={0} role="region" aria-label="Scrollable table">
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
