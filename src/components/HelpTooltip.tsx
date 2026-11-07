/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useRef, useEffect } from 'react';
import { HelpCircle } from 'lucide-react';
import { useHelpTips } from '../contexts/HelpTipsContext';
import { HELP_CONTENT, type HelpEntry } from '../lib/help-content';

interface HelpTooltipProps {
  /** Key into HELP_CONTENT */
  helpKey: string;
  /** Override size of the (?) icon — default 12 */
  size?: number;
  /** Extra class on the wrapper */
  className?: string;
}

/** Minimal Markdown-to-JSX: bold, newlines, unordered lists */
function renderMarkdown(md: string): React.ReactNode[] {
  const lines = md.split('\n');
  const nodes: React.ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length > 0) {
      nodes.push(
        <ul key={`ul-${nodes.length}`} className="ml-3 mt-1 space-y-0.5 list-disc list-inside">
          {listItems.map((item, i) => (
            <li key={i}>{formatInline(item)}</li>
          ))}
        </ul>
      );
      listItems = [];
    }
  };

  for (const line of lines) {
    const listMatch = line.match(/^- (.+)/);
    if (listMatch) {
      listItems.push(listMatch[1]);
    } else {
      flushList();
      if (line.trim() === '') {
        nodes.push(<br key={`br-${nodes.length}`} />);
      } else {
        nodes.push(<p key={`p-${nodes.length}`} className="mt-1 first:mt-0">{formatInline(line)}</p>);
      }
    }
  }
  flushList();
  return nodes;
}

function formatInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const boldMatch = part.match(/^\*\*(.+)\*\*$/);
    if (boldMatch) {
      return <strong key={i} className="font-semibold text-[var(--text)]">{boldMatch[1]}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

export function HelpTooltip({ helpKey, size = 12, className = '' }: HelpTooltipProps) {
  const { showTips } = useHelpTips();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const entry: HelpEntry | undefined = HELP_CONTENT[helpKey];

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Reposition tooltip to stay in viewport
  useEffect(() => {
    if (!open || !tooltipRef.current) return;
    const el = tooltipRef.current;
    const rect = el.getBoundingClientRect();
    // If overflowing right, shift left
    if (rect.right > window.innerWidth - 8) {
      el.style.left = 'auto';
      el.style.right = '0';
    }
    // If overflowing bottom, show above
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = 'auto';
      el.style.bottom = '100%';
      el.style.marginBottom = '4px';
    }
  }, [open]);

  if (!showTips || !entry) return null;

  const handleMouseEnter = () => {
    hoverTimeout.current = setTimeout(() => setOpen(true), 300);
  };

  const handleMouseLeave = () => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    // Don't close immediately on mouse leave — allow moving to tooltip
    hoverTimeout.current = setTimeout(() => setOpen(false), 200);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(!open);
  };

  return (
    <div
      ref={ref}
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(!open);
          }
        }}
        className="text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors opacity-50 hover:opacity-100 cursor-help inline-flex items-center"
        aria-label={`Help: ${entry.title}`}
      >
        <HelpCircle size={size} />
      </span>

      {open && (
        <div
          ref={tooltipRef}
          className="absolute z-50 top-full left-0 mt-1 w-72 rounded-lg bg-[var(--panel)] border border-[var(--border)] shadow-lg shadow-black/20 p-3 text-xs text-[var(--text-muted)] leading-relaxed"
          onMouseEnter={() => {
            if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
          }}
          onMouseLeave={handleMouseLeave}
        >
          <div className="font-semibold text-[var(--text)] mb-1 text-sm">{entry.title}</div>
          <div>{renderMarkdown(entry.body)}</div>
          {entry.learnMoreUrl && (
            <a
              href={entry.learnMoreUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-2 text-[var(--accent)] hover:underline text-xs"
            >
              Learn more &rarr;
            </a>
          )}
        </div>
      )}
    </div>
  );
}
