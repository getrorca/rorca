import { useState } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import AddWorkspaceModal from './AddWorkspaceModal';

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
        <span className="truncate max-w-[160px]">{selected?.name ?? 'Select workspace'}</span>
        <svg className="w-3 h-3 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
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

function GearIcon() {
  return (
    <button className="p-1.5 rounded hover:bg-bg transition-colors text-muted hover:text-[var(--text)]">
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    </button>
  );
}

export default function Shell({ sidebar, children }: { sidebar?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="h-screen flex flex-col bg-bg">
      {/* Top Nav — 48px */}
      <header className="h-12 flex items-center justify-between px-4 bg-panel border-b border-border shrink-0">
        <span className="font-mono font-bold text-accent text-sm tracking-tight">rorcha</span>
        <div className="flex items-center gap-2">
          <WorkspaceSelector />
          <GearIcon />
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
