import { Link, NavLink } from 'react-router-dom';
import { Zap, Github, User, CreditCard, ArrowLeft, BarChart3, ScrollText } from 'lucide-react';
import type { PanelId } from './Sidebar';
import type { SettingsTab } from '../panels/SettingsPanel';

interface SettingsSidebarProps {
    onNavigate: (panel: PanelId) => void;
}

export default function SettingsSidebar({ onNavigate }: SettingsSidebarProps) {
    const TABS: { id: SettingsTab; label: string; icon: typeof User }[] = [
        { id: 'account', label: 'Account', icon: User },
        { id: 'providers', label: 'Model & Providers', icon: Zap },
        { id: 'github', label: 'GitHub', icon: Github },
        { id: 'analytics', label: 'Analytics', icon: BarChart3 },
        { id: 'system', label: 'System', icon: ScrollText },
        { id: 'billing', label: 'Billing', icon: CreditCard },
    ];

    return (
        <div className="flex flex-col h-full w-full bg-panel border-r border-border shrink-0 font-sans min-w-0">
            {/* Top Section: Back to App */}
            <div className="p-3 flex flex-col gap-1.5 border-b border-border shrink-0">
                <Link
                    to="/"
                    onClick={(e) => { e.preventDefault(); onNavigate('hub'); }}
                    className="flex items-center gap-2 px-2 py-1 rounded text-[13px] text-[var(--text)] hover:bg-surface-100 transition-colors"
                >
                    <ArrowLeft size={14} className="text-muted shrink-0" />
                    <span className="font-medium truncate">Back to Rorca</span>
                </Link>
            </div>

            {/* Settings Navigation Sections */}
            <div className="flex-1 overflow-y-auto pt-2 pb-6 min-h-0">
                <div className="mb-1">
                    <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
                        Settings
                    </div>
                    <div className="space-y-[1px]">
                        {TABS.map((item) => {
                            const Icon = item.icon;
                            return (
                                <NavLink
                                    key={item.id}
                                    to={`/settings/${item.id}`}
                                    className={({ isActive }) =>
                                        `w-[calc(100%-16px)] flex items-center gap-2 px-3 mx-2 py-1 rounded text-[13px] transition-colors ${isActive
                                            ? 'text-[var(--text)] bg-surface-200 font-medium'
                                            : 'text-muted hover:bg-surface-100 hover:text-[var(--text)]'
                                        }`}
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
                </div>
            </div>
        </div>
    );
}
