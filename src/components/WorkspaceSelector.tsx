import { useState } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import AddWorkspaceModal from './AddWorkspaceModal';
import { Layers, Settings, LogOut, ChevronDown } from 'lucide-react';

interface WorkspaceSelectorProps {
    onNavigateSettings?: () => void;
}

export default function WorkspaceSelector({ onNavigateSettings }: WorkspaceSelectorProps) {
    const { workspaceId, setWorkspaceId, workspaces, addWorkspace } = useWorkspace();
    const { logout } = useAuth();
    const [open, setOpen] = useState(false);
    const [showAddModal, setShowAddModal] = useState(false);

    const selected = workspaces.find((w) => w.id === workspaceId);
    const fullName = selected?.name ?? 'Select workspace';

    return (
        <div className="relative w-full">
            <button
                onClick={() => setOpen(!open)}
                aria-label="Select workspace"
                aria-expanded={open}
                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-surface-100 cursor-pointer transition-colors border border-transparent focus-visible:border-accent outline-none group"
            >
                <div className="flex items-center gap-2 min-w-0">
                    <div className="w-5 h-5 shrink-0 rounded bg-accent/20 flex items-center justify-center text-accent">
                        <Layers size={12} />
                    </div>
                    <span className="font-semibold text-[13px] truncate text-[var(--text)]">{fullName}</span>
                </div>
                <ChevronDown
                    size={12}
                    className={`text-muted/60 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
                />
            </button>

            {open && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                    <div className="absolute left-0 right-0 top-full mt-1 bg-panel border border-border rounded-lg shadow-xl z-50 overflow-hidden py-1 min-w-[200px]">
                        {/* Primary actions */}
                        <button
                            onClick={() => {
                                setOpen(false);
                                // Navigate to settings — dispatch via sidebar's onNavigate
                                window.dispatchEvent(new CustomEvent('rorca:navigate', { detail: 'settings' }));
                            }}
                            className="w-full text-left px-3 py-1.5 text-[13px] text-muted hover:text-[var(--text)] hover:bg-surface-100 transition-colors flex items-center justify-between"
                        >
                            <span className="flex items-center gap-2">
                                <Settings size={14} className="text-muted/70" />
                                Settings
                            </span>
                            <span className="text-[10px] font-mono text-muted/50">G then S</span>
                        </button>

                        <div className="border-t border-border my-1" />

                        {/* Workspace list */}
                        <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted/50">
                            Switch workspace
                        </div>
                        {workspaces.map((w) => (
                            <button
                                key={w.id}
                                onClick={() => { setWorkspaceId(w.id); setOpen(false); }}
                                className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-surface-100 transition-colors flex items-center gap-2 ${w.id === workspaceId ? 'text-[var(--text)] font-medium' : 'text-muted'
                                    }`}
                            >
                                {w.id === workspaceId && <div className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                                <span className={w.id !== workspaceId ? 'ml-3.5' : ''} >{w.name}</span>
                            </button>
                        ))}
                        <button
                            onClick={() => { setOpen(false); setShowAddModal(true); }}
                            className="w-full text-left px-3 py-1.5 text-[13px] text-muted hover:text-[var(--text)] hover:bg-surface-100 transition-colors"
                        >
                            + Add Workspace
                        </button>

                        <div className="border-t border-border my-1" />

                        {/* Log out */}
                        <button
                            onClick={() => { setOpen(false); logout(); }}
                            className="w-full text-left px-3 py-1.5 text-[13px] text-muted hover:text-[var(--text)] hover:bg-surface-100 transition-colors flex items-center justify-between"
                        >
                            <span className="flex items-center gap-2">
                                <LogOut size={14} className="text-muted/70" />
                                Log out
                            </span>
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
