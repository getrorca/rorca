/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, type ThemeMode } from '../contexts/ThemeContext';

const modes: { mode: ThemeMode; icon: typeof Sun; label: string }[] = [
  { mode: 'light', icon: Sun, label: 'Light' },
  { mode: 'dark', icon: Moon, label: 'Dark' },
  { mode: 'system', icon: Monitor, label: 'System' },
];

export default function ThemeToggle() {
  const { mode, setMode } = useTheme();

  // Cycle through modes on click
  const cycle = () => {
    const idx = modes.findIndex((m) => m.mode === mode);
    setMode(modes[(idx + 1) % modes.length].mode);
  };

  const current = modes.find((m) => m.mode === mode) ?? modes[1];
  const Icon = current.icon;

  return (
    <button
      onClick={cycle}
      className="flex items-center justify-center w-8 h-8 rounded text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
      title={`Theme: ${current.label}`}
      aria-label={`Theme: ${current.label}. Click to switch.`}
    >
      <Icon size={16} strokeWidth={1.5} />
    </button>
  );
}
