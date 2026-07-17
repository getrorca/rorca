/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, type ComponentType } from 'react';
import { Link, NavLink } from 'react-router-dom';
import {
  Settings2, Layers, Route, Zap, Variable, Play, Webhook, Users,
  Keyboard, ArrowLeft, ChevronRight,
  Code2, Rss, Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { PanelId } from './Sidebar';
import { Github } from './icons/GithubIcon';
import type { SettingsTab } from '../panels/SettingsPanel';

interface SettingsSidebarProps {
  onNavigate: (panel: PanelId) => void;
}

interface SidebarItem {
  id: SettingsTab;
  label: string;
  icon: LucideIcon | ComponentType<{ size?: number; className?: string }>;
  badge?: string;
}

interface SettingsGroup {
  id: string;
  label: string;
  items: SidebarItem[];
}

const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      { id: 'general',   label: 'General',         icon: Settings2 },
      { id: 'env-vars',  label: 'Environment',     icon: Variable  },
      { id: 'hooks',     label: 'Pipeline Hooks',  icon: Webhook   },
      { id: 'agents',    label: 'Agent Profiles',  icon: Users     },
      { id: 'context',   label: 'Context Library', icon: Route     },
      { id: 'github',    label: 'GitHub',          icon: Github    },
    ],
  },
  {
    id: 'execution',
    label: 'Execution',
    items: [
      { id: 'providers', label: 'Providers & Models', icon: Zap    },
      { id: 'direction', label: 'Direction',           icon: Layers },
      { id: 'pipeline',  label: 'Pipeline Config',     icon: Play   },
    ],
  },
  {
    id: 'finops',
    label: 'FinOps',
    items: [
      { id: 'finops',    label: 'Billing Profiles', icon: Wallet },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'shortcuts', label: 'Shortcuts',       icon: Keyboard },
      { id: 'system',    label: 'Activity',        icon: Rss },
      { id: 'developer', label: 'Developer Tools', icon: Code2 },
    ],
  },
];

function GroupSection({ group, defaultOpen }: { group: SettingsGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted/70 hover:text-muted transition-colors"
      >
        <ChevronRight
          size={10}
          className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        {group.label}
      </button>
      {open && (
        <div className="space-y-[1px]">
          {group.items.map((item) => {
            const Icon = item.icon;
            const isDisabled = !!item.badge;
            if (isDisabled) {
              return (
                <div
                  key={item.id}
                  className="w-[calc(100%-16px)] flex items-center gap-2 px-3 mx-2 py-1 rounded text-[13px] text-muted/40 cursor-not-allowed"
                >
                  <Icon size={14} className="text-muted/30" />
                  <span className="truncate flex-1">{item.label}</span>
                  <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-surface-100 text-muted/50">
                    {item.badge}
                  </span>
                </div>
              );
            }
            return (
              <NavLink
                key={item.id}
                to={`/settings/${item.id}`}
                className={({ isActive }) =>
                  `w-[calc(100%-16px)] flex items-center gap-2 px-3 mx-2 py-1 rounded text-[13px] transition-colors ${
                    isActive
                      ? 'text-[var(--text)] bg-surface-200 font-medium'
                      : 'text-muted hover:bg-surface-100 hover:text-[var(--text)]'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon size={14} className={isActive ? 'text-accent' : 'text-muted/70'} />
                    <span className="truncate">{item.label}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function SettingsSidebar({ onNavigate }: SettingsSidebarProps) {
  return (
    <div className="flex flex-col h-full w-full bg-panel border-r border-border shrink-0 font-sans min-w-0">
      {/* Back to App */}
      <div className="p-3 flex flex-col gap-1.5 border-b border-border shrink-0">
        <Link
          to="/"
          onClick={(e) => { e.preventDefault(); onNavigate('specs'); }}
          className="flex items-center gap-2 px-2 py-1 rounded text-[13px] text-[var(--text)] hover:bg-surface-100 transition-colors"
        >
          <ArrowLeft size={14} className="text-muted shrink-0" />
          <span className="font-medium truncate">Back to Rorca</span>
        </Link>
      </div>

      {/* Grouped Settings Navigation */}
      <div className="flex-1 overflow-y-auto pt-2 pb-6 min-h-0">
        {SETTINGS_GROUPS.map((group) => (
          <GroupSection
            key={group.id}
            group={group}
            defaultOpen={true}
          />
        ))}
      </div>
    </div>
  );
}
