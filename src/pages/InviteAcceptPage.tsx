import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loader2, Mail, Shield, Users } from 'lucide-react';
import RorcaLogo from '../components/RorcaLogo';
import { useAuth } from '../contexts/AuthContext';
import { useGlobalToast } from '../contexts/ToastContext';
import { ApiError, apiFetch } from '../lib/apiFetch';

interface InviteDetails {
  teamId: string;
  teamName: string;
  teamSlug: string;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: string;
}

interface AcceptInviteResponse {
  teamId: string;
  teamName: string;
  teamSlug: string;
  role: string;
  message: string;
}

function mapInviteError(status?: number): string {
  if (status === 404) return 'Invalid invite link';
  if (status === 409) return "You're already a member";
  if (status === 410) return 'This invite has expired';
  if (status === 403) return 'This invite was sent to a different email address';
  return 'Unable to load invite';
}

export default function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { success } = useGlobalToast();

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [accepting, setAccepting] = useState(false);

  const returnTo = useMemo(() => (
    token ? `/invites/${token}` : '/'
  ), [token]);

  const loadInvite = useCallback(async () => {
    if (!token) {
      setError('Invalid invite link');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');

    try {
      const data = await apiFetch<InviteDetails>(`/api/invites/${encodeURIComponent(token)}`);
      setInvite(data);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      setInvite(null);
      setError(mapInviteError(status));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadInvite();
  }, [loadInvite]);

  const handleAccept = useCallback(async () => {
    if (!token || !invite) return;

    if (authLoading) {
      return;
    }

    if (!isAuthenticated) {
      navigate(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
      return;
    }

    setAccepting(true);
    setError('');

    try {
      const result = await apiFetch<AcceptInviteResponse>(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
      });
      success(`You joined ${result.teamName}`);
      navigate('/', { replace: true });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      setError(mapInviteError(status));
    } finally {
      setAccepting(false);
    }
  }, [authLoading, invite, isAuthenticated, navigate, returnTo, success, token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <RorcaLogo size={48} variant="gradient" className="mb-3" />
          <h1 className="font-mono text-2xl font-bold tracking-tight text-[var(--text)]">Rorca</h1>
          <p className="mt-1 text-sm text-muted">Team invite</p>
        </div>

        <div className="rounded-lg border border-border bg-panel p-6 shadow-sm">
          {loading ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center" aria-live="polite" aria-label="Loading invite details">
              <Loader2 className="h-6 w-6 animate-spin text-accent" aria-hidden="true" />
              <p className="text-sm text-muted">Loading invite details…</p>
            </div>
          ) : error || !invite ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-error/10 text-error">
                <Mail className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-[var(--text)]">Invite unavailable</h2>
                <p className="text-sm text-muted" role="alert">{error || 'Invalid invite link'}</p>
              </div>
              <Link
                to="/auth/login"
                className="inline-flex items-center justify-center rounded bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
              >
                Go to login
              </Link>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="space-y-2 text-center">
                <h2 className="text-xl font-semibold text-[var(--text)]">Join {invite.teamName}</h2>
                <p className="text-sm text-muted">
                  {invite.invitedBy} invited you to collaborate on this workspace.
                </p>
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-bg/60 p-4">
                <div className="flex items-start gap-3">
                  <Users className="mt-0.5 h-4 w-4 text-muted" aria-hidden="true" />
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted">Workspace</p>
                    <p className="text-sm font-medium text-[var(--text)]">{invite.teamName}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Mail className="mt-0.5 h-4 w-4 text-muted" aria-hidden="true" />
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted">Invited email</p>
                    <p className="text-sm font-medium text-[var(--text)]">{invite.email}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Shield className="mt-0.5 h-4 w-4 text-muted" aria-hidden="true" />
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted">Role</p>
                    <p className="text-sm font-medium capitalize text-[var(--text)]">{invite.role}</p>
                  </div>
                </div>
              </div>

              {error && (
                <p className="text-sm text-error" role="alert">{error}</p>
              )}

              <button
                type="button"
                onClick={() => void handleAccept()}
                disabled={accepting || authLoading}
                aria-label={`Accept invite to join ${invite.teamName}`}
                className="flex w-full items-center justify-center rounded bg-accent py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {accepting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : 'Accept invite'}
              </button>

              {!isAuthenticated && (
                <p className="text-center text-sm text-muted">
                  You’ll be asked to sign in before joining.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
