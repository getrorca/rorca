import { useState } from 'react';
import { Mail, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export default function EmailVerificationBanner() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  if (!user || user.emailVerified || dismissed) return null;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 flex items-center gap-3 text-sm">
      <Mail size={16} className="text-amber-500 shrink-0" />
      <span className="text-amber-200 flex-1">
        Email verification is managed by Supabase.
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="text-muted hover:text-[var(--text)] p-0.5"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
