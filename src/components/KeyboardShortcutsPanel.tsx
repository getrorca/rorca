/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Keyboard, X } from 'lucide-react';
import { modLabel } from '../hooks/useHotkeys';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface ShortcutDef {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  category: string;
  shortcuts: ShortcutDef[];
}

const mod = modLabel();

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    category: 'Global',
    shortcuts: [
      { keys: ['1'], description: 'Go to Today' },
      { keys: ['2'], description: 'Go to Missions' },
      { keys: ['3'], description: 'Go to Knowledge' },
      { keys: ['4'], description: 'Go to Insights' },
      { keys: ['5'], description: 'Go to Settings' },
      { keys: ['N'], description: 'New Mission brief' },
      { keys: ['R'], description: 'Go to Runs' },
      { keys: ['?'], description: 'Show this shortcuts overlay' },
      { keys: [`${mod}`, 'K'], description: 'Open command palette' },
      { keys: ['Esc'], description: 'Close overlay / modal' },
    ],
  },
  {
    category: 'Board Navigation',
    shortcuts: [
      { keys: ['J'], description: 'Move focus down (next card)' },
      { keys: ['K'], description: 'Move focus up (previous card)' },
      { keys: ['H'], description: 'Move focus left (previous column)' },
      { keys: ['L'], description: 'Move focus right (next column)' },
      { keys: ['Enter'], description: 'Open focused card detail' },
    ],
  },
  {
    category: 'Card Actions',
    shortcuts: [
      { keys: ['A'], description: 'Approve focused spec' },
      { keys: ['X'], description: 'Reject focused spec (with confirmation)' },
      { keys: ['E'], description: 'Edit focused spec brief' },
      { keys: ['D'], description: 'Delete focused spec (with confirmation)' },
    ],
  },
  {
    category: 'Command Palette',
    shortcuts: [
      { keys: ['\u2191', '\u2193'], description: 'Navigate results' },
      { keys: ['Enter'], description: 'Execute selected command' },
      { keys: ['Esc'], description: 'Close palette' },
    ],
  },
  {
    category: 'Specs',
    shortcuts: [
      { keys: [`${mod}`, 'Shift', 'N'], description: 'New spec (opens Forge)' },
      { keys: [`${mod}`, 'N'], description: 'Go to Specs' },
    ],
  },
];

interface KeyboardShortcutsPanelProps {
  onClose: () => void;
}

export default function KeyboardShortcutsPanel({ onClose }: KeyboardShortcutsPanelProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, undefined, { onEscape: onClose });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        ref={trapRef}
        className="bg-panel border border-border rounded-lg shadow-xl w-full max-w-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Keyboard size={16} className="text-accent" />
            <span className="text-sm font-medium text-text">Keyboard Shortcuts</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="p-1 rounded hover:bg-bg text-muted hover:text-text transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Shortcut groups */}
        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-5">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.category}>
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">
                {group.category}
              </h3>
              <div className="space-y-1">
                {group.shortcuts.map((shortcut, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-bg/50"
                  >
                    <span className="text-sm text-text">{shortcut.description}</span>
                    <div className="flex items-center gap-0.5 shrink-0 ml-4">
                      {shortcut.keys.map((key, ki) => (
                        <kbd
                          key={ki}
                          className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-[11px] font-mono text-muted bg-bg border border-border rounded"
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border text-[10px] text-muted text-center">
          Press <kbd className="bg-bg border border-border rounded px-1 py-0.5 font-mono">?</kbd> or{' '}
          <kbd className="bg-bg border border-border rounded px-1 py-0.5 font-mono">{mod}/</kbd> to
          toggle this panel
        </div>
      </div>
    </div>
  );
}
