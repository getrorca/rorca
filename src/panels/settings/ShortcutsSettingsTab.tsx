/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { modLabel } from '../../hooks/useHotkeys';

// ─── Shortcuts Section ───────────────────────────────────────────────────────

const SHORTCUT_GROUPS = (() => {
  const mod = modLabel();
  return [
    {
      category: 'Navigation',
      shortcuts: [
        { keys: ['1'], description: `Go to Specs (also ${mod}+1)` },
        { keys: ['2'], description: `Go to Runs (also ${mod}+2)` },
        { keys: ['3'], description: `Go to Analytics (also ${mod}+3)` },
        { keys: ['4'], description: `Go to Direction (also ${mod}+4)` },
        { keys: ['5'], description: `Go to Settings (also ${mod}+5)` },
        { keys: ['R'], description: 'Go to Runs' },
      ],
    },
    {
      category: 'Specs',
      shortcuts: [
        { keys: ['N'], description: 'Start a new spec' },
        { keys: [`${mod}`, 'Shift', 'N'], description: 'Start a new spec' },
        { keys: [`${mod}`, 'N'], description: 'Go to Specs' },
      ],
    },
    {
      category: 'General',
      shortcuts: [
        { keys: [`${mod}`, 'K'], description: 'Open command palette' },
        { keys: ['?'], description: 'Open shortcuts' },
        { keys: [`${mod}`, '/'], description: 'Open shortcuts' },
        { keys: ['Esc'], description: 'Close the active overlay' },
      ],
    },
  ];
})();

export function ShortcutsSettingsTab() {
  return (
    <div className="max-w-lg space-y-5">
      <h2 className="text-sm font-semibold text-[var(--text)]">Keyboard Shortcuts</h2>
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
                <span className="text-sm text-[var(--text)]">{shortcut.description}</span>
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
  );
}
