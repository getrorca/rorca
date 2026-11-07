/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink } from 'react-router';
import {
  Settings2, Layers, Route, Zap, Variable, Play, Webhook, Users,
  Keyboard, ArrowLeft, ChevronRight, Menu, X,
  Code2, Rss, Wallet, MonitorCog,
  type LucideIcon,
} from 'lucide-react';
import type { PanelId } from './Sidebar';
import { Github } from './icons/GithubIcon';
import type { SettingsTab } from '../panels/SettingsPanel';
import WorkspaceSelector from './WorkspaceSelector';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useFocusTrap } from '../hooks/useFocusTrap';

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
      { id: 'pty-recovery', label: 'PTY Recovery',      icon: MonitorCog },
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

function GroupSection({ group, defaultOpen, onItemNavigate }: { group: SettingsGroup; defaultOpen: boolean; onItemNavigate?: () => void }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-[var(--text)] transition-colors"
        aria-expanded={open}
        aria-controls={`settings-group-${group.id}`}
      >
        <ChevronRight
          size={10}
          className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        {group.label}
      </button>
      {open && (
        <div id={`settings-group-${group.id}`} className="space-y-[1px]">
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
                onClick={onItemNavigate}
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
                    <Icon size={14} className={isActive ? 'text-accent' : 'text-muted'} />
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
  const breakpoint = useBreakpoint();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const dialogRef = useFocusTrap<HTMLElement>(breakpoint !== 'desktop' && open, triggerRef, {
    onEscape: close,
  });

  const sidebarContent = (
    <div className="flex h-full w-full min-w-0 shrink-0 flex-col border-r border-border bg-panel font-sans">
      <div className="border-b border-border p-3">
        <WorkspaceSelector />
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border p-3">
        <Link
          to="/"
          onClick={(event) => {
            event.preventDefault();
            close();
            onNavigate('specs');
          }}
          className="flex items-center gap-2 rounded px-2 py-1 text-[13px] text-[var(--text)] transition-colors hover:bg-surface-200"
        >
          <ArrowLeft size={14} className="shrink-0 text-muted" aria-hidden="true" />
          <span className="truncate font-medium">Back to Rorca</span>
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6 pt-2">
        {SETTINGS_GROUPS.map((group) => (
          <GroupSection
            key={group.id}
            group={group}
            defaultOpen
            onItemNavigate={breakpoint === 'desktop' ? undefined : close}
          />
        ))}
      </div>
    </div>
  );


  if (breakpoint === 'desktop') return sidebarContent;

  return (
    <>
      <div role="navigation" aria-label="Settings navigation controls" className="sticky top-0 z-30 shrink-0 border-b border-border bg-panel px-3 py-2">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="responsive-settings-navigation"
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm font-medium text-[var(--text)] hover:bg-surface-200"
        >
          <Menu size={16} aria-hidden="true" />
          Settings navigation
        </button>
      </div>
      {open && typeof document !== 'undefined'
        ? createPortal(
          <>
            <div className="fixed inset-0 z-40 bg-[var(--backdrop)]" onClick={close} aria-hidden="true" />
            <aside
              ref={dialogRef}
              id="responsive-settings-navigation"
              role="dialog"
              aria-modal="true"
              aria-labelledby="responsive-settings-navigation-title"
              className="fixed inset-y-0 left-0 z-50 flex w-full max-w-xs flex-col bg-panel shadow-2xl"
            >
              <div className="flex min-h-14 items-center justify-between border-b border-border px-3">
                <h2 id="responsive-settings-navigation-title" className="text-sm font-semibold text-[var(--text)]">
                  Settings navigation
                </h2>
                <button
                  type="button"
                  onClick={close}
                  className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md text-muted hover:bg-surface-200 hover:text-[var(--text)]"
                  aria-label="Close settings navigation"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
              <div className="min-h-0 flex-1">{sidebarContent}</div>
            </aside>
          </>,
          document.body,
        )
        : null}
    </>
  );
}

