import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Mail, Trash2, UserPlus, Users } from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useGlobalToast } from '../../contexts/ToastContext';
import { apiFetch } from '../../lib/apiFetch';

type TeamRole = 'owner' | 'admin' | 'member' | 'editor' | 'viewer';
type InviteRole = 'admin' | 'member';

interface Team {
  id: string;
  name: string;
  slug: string;
  role?: string;
}

interface TeamMember {
  userId: string;
  email: string;
  displayName: string;
  role: TeamRole;
  joinedAt: string;
  acceptedAt: string | null;
  lastActiveAt: string | null;
}

interface TeamMembersResponse {
  teamId: string;
  teamName: string;
  members: TeamMember[];
}

const badgeClassByRole: Record<string, string> = {
  owner: 'bg-surface-200 text-[var(--text)] border border-border',
  admin: 'bg-accent/12 text-accent border border-accent/20',
  member: 'bg-surface-200 text-muted border border-border',
  editor: 'bg-surface-200 text-muted border border-border',
  viewer: 'bg-surface-200 text-muted border border-border',
};

const memberRoleOptions: Array<{ value: 'admin' | 'editor' | 'viewer'; label: string }> = [
  { value: 'admin', label: 'Admin' },
  { value: 'editor', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

const inviteRoleOptions: Array<{ value: InviteRole; apiValue: 'admin' | 'editor'; label: string }> = [
  { value: 'member', apiValue: 'editor', label: 'Member' },
  { value: 'admin', apiValue: 'admin', label: 'Admin' },
];

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getInitials(name: string, email: string): string {
  const source = name.trim() || email.trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function normalizeRole(role: string): TeamRole {
  if (role === 'editor') return 'member';
  if (role === 'viewer') return 'member';
  return (role as TeamRole) || 'member';
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="rounded-2xl border border-border bg-panel p-6 space-y-4">
        <div className="h-6 w-40 rounded bg-surface-200" />
        <div className="grid gap-3 md:grid-cols-3">
          <div className="h-10 rounded bg-surface-200 md:col-span-2" />
          <div className="h-10 rounded bg-surface-200" />
        </div>
        <div className="h-10 w-36 rounded bg-surface-200" />
      </div>
      <div className="rounded-2xl border border-border bg-panel p-6 space-y-3">
        <div className="h-6 w-32 rounded bg-surface-200" />
        <div className="h-14 rounded bg-surface-100" />
        <div className="h-14 rounded bg-surface-100" />
      </div>
    </div>
  );
}

export function TeamSettingsTab() {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();

  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [recentInvite, setRecentInvite] = useState<{ email: string; role: InviteRole; createdAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRole>('member');
  const [submittingInvite, setSubmittingInvite] = useState(false);
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<TeamMember | null>(null);

  const canManageTeam = useMemo(() => {
    const activeTeam = teams.find((team) => team.id === selectedTeamId);
    return activeTeam?.role === 'owner' || activeTeam?.role === 'admin';
  }, [teams, selectedTeamId]);

  const loadTeamData = useCallback(async (teamId: string) => {
    const membersResponse = await apiFetch<TeamMembersResponse>(`/api/teams/${teamId}/members`);
    setMembers(membersResponse.members);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const response = await apiFetch<{ items: Team[]; total: number }>(`/api/teams${workspaceId ? `?workspaceId=${workspaceId}` : ''}`);
        if (cancelled) return;
        const nextTeams = response.items ?? [];
        setTeams(nextTeams);

        const nextTeamId = nextTeams[0]?.id ?? '';
        setSelectedTeamId((current) => (current && nextTeams.some((team) => team.id === current) ? current : nextTeamId));

        if (nextTeamId) {
          const activeTeamId = nextTeams.some((team) => team.id === selectedTeamId) ? selectedTeamId : nextTeamId;
          await loadTeamData(activeTeamId);
        } else {
          setMembers([]);
          setRecentInvite(null);
        }
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : 'Failed to load team settings');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, loadTeamData, selectedTeamId, toast]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedTeamId) return;

    const refresh = async () => {
      try {
        await loadTeamData(selectedTeamId);
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : 'Failed to refresh team data');
        }
      }
    };

    refresh();

    return () => {
      cancelled = true;
    };
  }, [selectedTeamId, loadTeamData, toast]);

  const handleInviteSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTeamId) return;

    const trimmedEmail = inviteEmail.trim().toLowerCase();
    if (!trimmedEmail) {
      toast.error('Enter an email address');
      return;
    }

    setSubmittingInvite(true);
    try {
      const rolePayload = inviteRoleOptions.find((option) => option.value === inviteRole)?.apiValue ?? 'editor';
      await apiFetch(`/api/teams/${selectedTeamId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, role: rolePayload }),
      });
      setInviteEmail('');
      setInviteRole('member');
      setRecentInvite({ email: trimmedEmail, role: inviteRole, createdAt: new Date().toISOString() });
      toast.success('Invite sent');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send invite');
    } finally {
      setSubmittingInvite(false);
    }
  }, [inviteEmail, inviteRole, selectedTeamId, toast]);

  const handleRoleChange = useCallback(async (member: TeamMember, nextRole: 'admin' | 'editor' | 'viewer') => {
    if (!selectedTeamId) return;
    setUpdatingMemberId(member.userId);
    try {
      await apiFetch(`/api/teams/${selectedTeamId}/members/${member.userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole }),
      });
      await loadTeamData(selectedTeamId);
      toast.success('Member role updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update role');
    } finally {
      setUpdatingMemberId(null);
    }
  }, [loadTeamData, selectedTeamId, toast]);

  const confirmRemoveMember = useCallback(async () => {
    if (!selectedTeamId || !memberToRemove) return;
    setUpdatingMemberId(memberToRemove.userId);
    try {
      await apiFetch(`/api/teams/${selectedTeamId}/members/${memberToRemove.userId}`, {
        method: 'DELETE',
      });
      await loadTeamData(selectedTeamId);
      toast.success('Member removed');
      setMemberToRemove(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove member');
    } finally {
      setUpdatingMemberId(null);
    }
  }, [loadTeamData, memberToRemove, selectedTeamId, toast]);

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (teams.length === 0 || !selectedTeamId) {
    return (
      <section className="rounded-2xl border border-border bg-panel p-10 text-center">
        <Users className="mx-auto mb-4 h-10 w-10 text-muted/50" />
        <h2 className="text-lg font-semibold text-[var(--text)]">No team yet</h2>
        <p className="mt-2 text-sm text-muted">No other team members yet — invite collaborators</p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-panel p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-[var(--text)]">Team management</h2>
            <p className="text-sm text-muted">Manage members, roles, and pending invites for your current team.</p>
          </div>
          {teams.length > 1 && (
            <label className="flex flex-col gap-1 text-sm text-muted" htmlFor="team-settings-select">
              Team
              <select
                id="team-settings-select"
                aria-label="Select team"
                value={selectedTeamId}
                onChange={(event) => setSelectedTeamId(event.target.value)}
                className="min-w-56 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-[var(--text)] outline-none transition focus:border-accent"
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>{team.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-panel p-6">
        <div className="mb-4 flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-accent" />
          <h3 className="text-base font-semibold text-[var(--text)]">Invite collaborator</h3>
        </div>
        <form className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto]" onSubmit={handleInviteSubmit}>
          <label className="flex flex-col gap-1 text-sm text-muted" htmlFor="team-invite-email">
            Email
            <input
              id="team-invite-email"
              aria-label="Invite collaborator email"
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="name@company.com"
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-[var(--text)] outline-none transition focus:border-accent"
              disabled={!canManageTeam || submittingInvite}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted" htmlFor="team-invite-role">
            Role
            <select
              id="team-invite-role"
              aria-label="Select invite role"
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as InviteRole)}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-[var(--text)] outline-none transition focus:border-accent"
              disabled={!canManageTeam || submittingInvite}
            >
              {inviteRoleOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            aria-label="Send team invite"
            disabled={!canManageTeam || submittingInvite}
            className="inline-flex h-10 items-center justify-center gap-2 self-end rounded-lg bg-accent px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submittingInvite ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            Send invite
          </button>
        </form>
        {!canManageTeam && (
          <p className="mt-3 text-sm text-muted">You need owner or admin access to invite collaborators.</p>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-panel p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-[var(--text)]">Team members</h3>
            <p className="text-sm text-muted">Current members and their workspace access level.</p>
          </div>
          <span className="text-xs text-muted">{members.length} {members.length === 1 ? 'member' : 'members'}</span>
        </div>

        {members.length <= 1 ? (
          <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <Users className="mx-auto mb-3 h-8 w-8 text-muted/50" />
            <p className="text-sm text-muted">No other team members yet — invite collaborators</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-3 pr-4 font-medium">Member</th>
                  <th className="py-3 pr-4 font-medium">Role</th>
                  <th className="py-3 pr-4 font-medium">Joined</th>
                  <th className="py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {members.map((member) => {
                  const isOwner = member.role === 'owner';
                  const normalizedRole = normalizeRole(member.role);
                  const roleBadgeClass = badgeClassByRole[normalizedRole] ?? badgeClassByRole.member;
                  const isBusy = updatingMemberId === member.userId;

                  return (
                    <tr key={member.userId}>
                      <td className="py-4 pr-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-200 text-sm font-semibold text-[var(--text)]">
                            {getInitials(member.displayName, member.email)}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-[var(--text)]">
                              {member.displayName || member.email}
                            </div>
                            <div className="truncate text-sm text-muted">{member.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-4 pr-4">
                        <div className="flex items-center gap-3">
                          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${roleBadgeClass}`}>
                            {normalizedRole}
                          </span>
                          {canManageTeam && !isOwner ? (
                            <select
                              aria-label={`Change role for ${member.email}`}
                              value={member.role}
                              onChange={(event) => handleRoleChange(member, event.target.value as 'admin' | 'editor' | 'viewer')}
                              disabled={isBusy}
                              className="rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-[var(--text)] outline-none transition focus:border-accent disabled:opacity-50"
                            >
                              {memberRoleOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-4 pr-4 text-sm text-muted">{formatDate(member.acceptedAt ?? member.joinedAt)}</td>
                      <td className="py-4 text-right">
                        {canManageTeam && !isOwner ? (
                          <button
                            type="button"
                            aria-label={`Remove ${member.email} from team`}
                            onClick={() => setMemberToRemove(member)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted transition hover:border-danger/30 hover:text-danger disabled:opacity-50"
                          >
                            {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            Remove
                          </button>
                        ) : (
                          <span className="text-sm text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-panel p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-[var(--text)]">Pending invites</h3>
            <p className="text-sm text-muted">New invites appear here for the current session after they are sent.</p>
          </div>
          <span className="text-xs text-muted">{recentInvite ? '1 pending' : '0 pending'}</span>
        </div>

        {!recentInvite ? (
          <div className="rounded-xl border border-dashed border-border px-6 py-8 text-center text-sm text-muted">
            No pending invites to show yet
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[var(--text)]">{recentInvite.email}</div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${badgeClassByRole[recentInvite.role] ?? badgeClassByRole.member}`}>
                  {recentInvite.role}
                </span>
                <span>Sent {formatDate(recentInvite.createdAt)}</span>
              </div>
            </div>
            <span className="text-sm text-muted">Invite sent successfully</span>
          </div>
        )}
      </section>

      {memberToRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div role="alertdialog" aria-modal="true" aria-labelledby="team-remove-member-title" className="w-full max-w-md rounded-2xl border border-border bg-panel p-6 shadow-2xl">
            <h3 id="team-remove-member-title" className="text-lg font-semibold text-[var(--text)]">Remove team member?</h3>
            <p className="mt-2 text-sm text-muted">
              Remove <span className="font-medium text-[var(--text)]">{memberToRemove.email}</span> from this team. They will lose access immediately.
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                aria-label="Cancel member removal"
                onClick={() => setMemberToRemove(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition hover:text-[var(--text)]"
              >
                Cancel
              </button>
              <button
                type="button"
                aria-label="Confirm member removal"
                onClick={confirmRemoveMember}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
              >
                Remove member
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TeamSettingsTab;
