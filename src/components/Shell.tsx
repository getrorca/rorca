import { useState } from 'react';
import { Menu, HelpCircle, Settings } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import { useHelpTips } from '../contexts/HelpTipsContext';
import AddWorkspaceModal from './AddWorkspaceModal';
import ThemeToggle from './ThemeToggle';
import NotificationBell from './NotificationBell';
import type { PanelId } from './Sidebar';

function WorkspaceSelector() {
  const { workspaceId, setWorkspaceId, workspaces, addWorkspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  const selected = workspaces.find((w) => w.id === workspaceId);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded text-sm bg-bg border border-border hover:border-accent transition-colors"
      >
        <span className="truncate max-w-[100px] sm:max-w-[160px]">{selected?.name ?? 'Select workspace'}</span>
        <svg className="w-3 h-3 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-56 bg-panel border border-border rounded shadow-lg z-50">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => { setWorkspaceId(w.id); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-bg transition-colors ${
                  w.id === workspaceId ? 'text-accent' : 'text-[var(--text)]'
                }`}
              >
                {w.name}
              </button>
            ))}
            {workspaces.length > 0 && <div className="border-t border-border" />}
            <button
              onClick={() => { setOpen(false); setShowAddModal(true); }}
              className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-bg transition-colors"
            >
              + Add Workspace
            </button>
          </div>
        </>
      )}

      {showAddModal && (
        <AddWorkspaceModal
          onClose={() => setShowAddModal(false)}
          onSuccess={(ws) => {
            addWorkspace(ws);
            setShowAddModal(false);
          }}
        />
      )}
    </div>
  );
}

function UserMenu({ onNavigate }: { onNavigate?: (panel: PanelId) => void }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-2 py-1.5 rounded text-sm text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
        title={user.email}
      >
        <span className="w-6 h-6 rounded-full bg-accent/20 text-accent text-xs font-medium flex items-center justify-center">
          {user.displayName.charAt(0).toUpperCase()}
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-48 bg-panel border border-border rounded shadow-lg z-50">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-sm text-[var(--text)] truncate">{user.displayName}</p>
              <p className="text-xs text-muted truncate">{user.email}</p>
            </div>
            <button
              onClick={() => { setOpen(false); onNavigate?.('settings'); }}
              className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-bg hover:text-[var(--text)] transition-colors flex items-center gap-2"
            >
              <Settings size={14} />
              Settings
            </button>
            <button
              onClick={() => { setOpen(false); logout(); }}
              className="w-full text-left px-3 py-2 text-sm text-muted hover:bg-bg hover:text-[var(--text)] transition-colors"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ShowTipsToggle() {
  const { showTips, setShowTips } = useHelpTips();
  return (
    <button
      onClick={() => setShowTips(!showTips)}
      className={`flex items-center gap-1 px-2 py-1.5 rounded text-xs transition-colors ${
        showTips
          ? 'text-accent bg-accent/10 hover:bg-accent/20'
          : 'text-muted hover:text-[var(--text)] hover:bg-bg'
      }`}
      title={showTips ? 'Hide help tips' : 'Show help tips'}
      aria-label={showTips ? 'Hide help tips' : 'Show help tips'}
    >
      <HelpCircle size={14} />
      <span className="hidden sm:inline">Tips</span>
    </button>
  );
}

interface ShellProps {
  sidebar?: React.ReactNode;
  children?: React.ReactNode;
  onMenuToggle?: () => void;
  showMenuButton?: boolean;
  onNavigate?: (panel: PanelId) => void;
}

export default function Shell({ sidebar, children, onMenuToggle, showMenuButton, onNavigate }: ShellProps) {
  return (
    <div className="h-screen flex flex-col bg-bg">
      {/* Top Nav — 48px */}
      <header className="h-12 flex items-center justify-between px-3 sm:px-4 bg-panel border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          {/* Hamburger — mobile only, when sidebar exists */}
          {showMenuButton && (
            <button
              onClick={onMenuToggle}
              className="md:hidden w-11 h-11 flex items-center justify-center text-muted hover:text-[var(--text)] transition-colors"
              aria-label="Open navigation menu"
            >
              <Menu size={20} />
            </button>
          )}
          <span className="font-mono font-bold text-accent text-sm tracking-tight">rorcha</span>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <WorkspaceSelector />
          <ShowTipsToggle />
          <NotificationBell onNavigate={onNavigate} />
          <ThemeToggle />
          <UserMenu onNavigate={onNavigate} />
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {sidebar}

        {/* Content Area */}
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
