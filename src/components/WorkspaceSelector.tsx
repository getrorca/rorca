import { useState, useRef, useEffect } from 'react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import AddWorkspaceModal from './AddWorkspaceModal';
import { Settings, LogOut, ChevronDown, Plus, Check } from 'lucide-react';

interface WorkspaceSelectorProps {
    onNavigateSettings?: () => void;
}

export default function WorkspaceSelector({ onNavigateSettings: _onNavigateSettings }: WorkspaceSelectorProps) {
    const { workspaceId, setWorkspaceId, workspaces, addWorkspace } = useWorkspace();
    const { signOut } = useAuth();
    const [open, setOpen] = useState(false);
    const [showAddModal, setShowAddModal] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    const selected = workspaces.find((w) => w.id === workspaceId);
    const fullName = selected?.name ?? 'Select workspace';

    // Close on click outside
    useEffect(() => {
        if (!open) return;
        function handleClick(e: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
                triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        function handleKey(e: KeyboardEvent) {
            if (e.key === 'Escape') setOpen(false);
        }
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [open]);

    // Generate workspace initial + color
    const wsInitial = (name: string) => name.charAt(0).toUpperCase();
    const wsColor = (id: string) => {
        const colors = [
            'bg-blue-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500',
            'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500',
        ];
        const hash = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        return colors[hash % colors.length];
    };

    return (
        <div className="relative w-full">
            {/* Trigger button */}
            <button
                ref={triggerRef}
                onClick={() => setOpen(!open)}
                aria-label="Select workspace"
                aria-expanded={open}
                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--surface-100)] cursor-pointer transition-colors border border-transparent focus-visible:border-accent outline-none group"
            >
                <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`w-5 h-5 shrink-0 rounded ${wsColor(String(workspaceId ?? '0'))} flex items-center justify-center`}>
                        <span className="text-white text-[10px] font-bold leading-none">{wsInitial(fullName)}</span>
                    </div>
                    <span className="font-semibold text-[13px] truncate text-[var(--text)]">{fullName}</span>
                </div>
                <ChevronDown
                    size={12}
                    className={`text-muted/60 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
                />
            </button>

            {/* Dropdown menu */}
            {open && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                    <div
                        ref={menuRef}
                        className="absolute left-0 right-0 top-full mt-1 bg-[var(--panel)] border border-[var(--border)] rounded-lg z-50 overflow-hidden min-w-[220px] animate-in fade-in slide-in-from-top-1 duration-150"
                        style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)' }}
                    >
                        {/* Workspace list */}
                        <div className="py-1.5">
                            {workspaces.map((w) => {
                                const isActive = w.id === workspaceId;
                                return (
                                    <button
                                        key={w.id}
                                        onClick={() => { setWorkspaceId(w.id); setOpen(false); }}
                                        className={`w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center gap-2.5 ${
                                            isActive
                                                ? 'bg-accent/8 text-[var(--text)]'
                                                : 'text-[var(--text)]/80 hover:bg-[var(--surface-100)]'
                                        }`}
                                    >
                                        <div className={`w-5 h-5 shrink-0 rounded ${wsColor(String(w.id))} flex items-center justify-center`}>
                                            <span className="text-white text-[10px] font-bold leading-none">{wsInitial(w.name)}</span>
                                        </div>
                                        <span className={`flex-1 truncate ${isActive ? 'font-medium' : ''}`}>{w.name}</span>
                                        {isActive && <Check size={14} className="text-accent shrink-0" />}
                                    </button>
                                );
                            })}
                        </div>

                        <div className="border-t border-[var(--border)]" />

                        {/* Actions */}
                        <div className="py-1.5">
                            <button
                                onClick={() => { setOpen(false); setShowAddModal(true); }}
                                className="w-full text-left px-3 py-2 text-[13px] text-muted hover:text-[var(--text)] hover:bg-[var(--surface-100)] transition-colors flex items-center gap-2.5"
                            >
                                <Plus size={14} className="text-muted/70" />
                                <span>Add workspace</span>
                            </button>
                            <button
                                onClick={() => {
                                    setOpen(false);
                                    window.dispatchEvent(new CustomEvent('rorca:navigate', { detail: 'settings' }));
                                }}
                                className="w-full text-left px-3 py-2 text-[13px] text-muted hover:text-[var(--text)] hover:bg-[var(--surface-100)] transition-colors flex items-center gap-2.5 justify-between"
                            >
                                <span className="flex items-center gap-2.5">
                                    <Settings size={14} className="text-muted/70" />
                                    Settings
                                </span>
                                <span className="text-[10px] font-mono text-muted/40">G then S</span>
                            </button>
                        </div>

                        <div className="border-t border-[var(--border)]" />

                        {/* Log out */}
                        <div className="py-1.5">
                            <button
                                onClick={() => { setOpen(false); void signOut(); }}
                                className="w-full text-left px-3 py-2 text-[13px] text-muted hover:text-[var(--text)] hover:bg-[var(--surface-100)] transition-colors flex items-center gap-2.5"
                            >
                                <LogOut size={14} className="text-muted/70" />
                                <span>Log out</span>
                            </button>
                        </div>
                    </div>
                </>
            )}

            {showAddModal && (
                <AddWorkspaceModal
                    onClose={() => setShowAddModal(false)}
                    onSuccess={(ws) => {
                        addWorkspace(ws);
                        setShowAddModal(false);
                        if (ws.needsBootstrap) {
                            sessionStorage.setItem(`rorca_needs_bootstrap_${ws.id}`, '1');
                            window.dispatchEvent(new CustomEvent('rorca:navigate', { detail: 'hub' }));
                        }
                    }}
                />
            )}
        </div>
    );
}
