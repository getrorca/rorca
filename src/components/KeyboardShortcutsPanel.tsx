import { useEffect } from 'react';
import { Keyboard, X } from 'lucide-react';
import { modLabel } from '../hooks/useHotkeys';

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
      { keys: [`${mod}`, 'K'], description: 'Open command palette' },
      { keys: ['?'], description: 'Show keyboard shortcuts' },
      { keys: [`${mod}`, '/'], description: 'Show keyboard shortcuts' },
      { keys: ['Esc'], description: 'Close panel / modal' },
    ],
  },
  {
    category: 'Navigation',
    shortcuts: [
      { keys: [`${mod}`, '1'], description: 'Go to Spec Forge' },
      { keys: [`${mod}`, '2'], description: 'Go to Direction Stack' },
      { keys: [`${mod}`, '3'], description: 'Go to Review Queue' },
      { keys: [`${mod}`, '4'], description: 'Go to Pipeline Monitor' },
      { keys: [`${mod}`, '5'], description: 'Go to Archive' },
    ],
  },
  {
    category: 'Spec Actions',
    shortcuts: [
      { keys: [`${mod}`, 'Enter'], description: 'Approve selected spec' },
      { keys: [`${mod}`, 'Backspace'], description: 'Reject selected spec' },
      { keys: [`${mod}`, 'N'], description: 'New spec in Spec Forge' },
    ],
  },
  {
    category: 'Pipeline Actions',
    shortcuts: [
      { keys: [`${mod}`, 'Shift', 'R'], description: 'Trigger pipeline run' },
      { keys: [`${mod}`, '.'], description: 'Cancel active run' },
    ],
  },
];

interface KeyboardShortcutsPanelProps {
  onClose: () => void;
}

export default function KeyboardShortcutsPanel({ onClose }: KeyboardShortcutsPanelProps) {
  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
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
