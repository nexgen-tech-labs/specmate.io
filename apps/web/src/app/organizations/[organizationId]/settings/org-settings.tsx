'use client';

import { useState } from 'react';
import Link from 'next/link';

type OrgSize = 'SOLO' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'ENTERPRISE';
type OrgRole = 'OWNER' | 'ADMIN';

const ORG_SIZES: OrgSize[] = ['SOLO', 'SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE'];

type Workspace = { id: string; name: string };
type Member = { userId: string; role: OrgRole; name: string; email: string };

function OrgDetailsSection({
  organizationId,
  initialName,
  initialSize,
  isOwner,
}: {
  organizationId: string;
  initialName: string;
  initialSize: OrgSize | null;
  isOwner: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [size, setSize] = useState<OrgSize | ''>(initialSize ?? '');
  const [savedName, setSavedName] = useState(initialName);
  const [savedSize, setSavedSize] = useState<OrgSize | null>(initialSize);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOwner) {
    return (
      <section className="rounded-lg border border-line bg-panel p-6">
        <h2 className="text-lg font-semibold text-ink">Organization</h2>
        <p className="mt-2 text-sm text-sub">Name: {savedName}</p>
        <p className="mt-1 text-sm text-sub">Size: {savedSize ?? 'Not set'}</p>
      </section>
    );
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/organizations/${organizationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, size: size || undefined }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not update the organization.');
      return;
    }
    const updated: { name: string; size: OrgSize | null } = await res.json();
    setSavedName(updated.name);
    setSavedSize(updated.size);
  }

  return (
    <section className="rounded-lg border border-line bg-panel p-6">
      <h2 className="text-lg font-semibold text-ink">Organization</h2>
      <form className="mt-4 space-y-4" onSubmit={(e) => void handleSave(e)}>
        <div>
          <label htmlFor="org-name" className="block text-sm font-medium text-ink">
            Name
          </label>
          <input
            id="org-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink"
          />
        </div>
        <div>
          <label htmlFor="org-size" className="block text-sm font-medium text-ink">
            Size
          </label>
          <select
            id="org-size"
            value={size}
            onChange={(e) => setSize(e.target.value as OrgSize | '')}
            className="mt-1 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink"
          >
            <option value="">Not set</option>
            {ORG_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-cobalt px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Save
        </button>
        {error ? <p className="text-sm text-red">{error}</p> : null}
      </form>
    </section>
  );
}

function WorkspacesSection({
  organizationId,
  initialWorkspaces,
}: {
  organizationId: string;
  initialWorkspaces: Workspace[];
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(initialWorkspaces);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [archiveError, setArchiveError] = useState<Record<string, string>>({});

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/organizations/${organizationId}/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not create the workspace.');
      return;
    }
    const created: Workspace = await res.json();
    setWorkspaces((prev) => [...prev, created]);
    setNewName('');
  }

  async function handleArchive(workspaceId: string) {
    setArchiveError((prev) => {
      const next = { ...prev };
      delete next[workspaceId];
      return next;
    });
    const res = await fetch(`/api/workspaces/${workspaceId}`, { method: 'DELETE' });
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setArchiveError((prev) => ({
        ...prev,
        [workspaceId]: body.error ?? 'Could not archive the workspace.',
      }));
      return;
    }
    setWorkspaces((prev) => prev.filter((w) => w.id !== workspaceId));
  }

  return (
    <section className="rounded-lg border border-line bg-panel p-6">
      <h2 className="text-lg font-semibold text-ink">Workspaces</h2>
      <ul className="mt-4 space-y-2">
        {workspaces.map((w) => (
          <li
            key={w.id}
            className="flex items-center justify-between rounded border border-line bg-paper px-3 py-2"
          >
            <Link href={`/workspaces/${w.id}/settings`} className="text-sm text-cobalt">
              {w.name}
            </Link>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleArchive(w.id)}
                className="text-sm font-medium text-red"
              >
                Archive
              </button>
            </div>
            {archiveError[w.id] ? <p className="text-sm text-red">{archiveError[w.id]}</p> : null}
          </li>
        ))}
        {workspaces.length === 0 ? <p className="text-sm text-sub">No workspaces yet.</p> : null}
      </ul>
      <form className="mt-4 flex items-end gap-2" onSubmit={(e) => void handleCreate(e)}>
        <div className="flex-1">
          <label htmlFor="new-workspace-name" className="block text-sm font-medium text-ink">
            Create workspace
          </label>
          <input
            id="new-workspace-name"
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="mt-1 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink"
          />
        </div>
        <button
          type="submit"
          disabled={submitting || !newName.trim()}
          className="rounded bg-cobalt px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Create
        </button>
      </form>
      {error ? <p className="mt-2 text-sm text-red">{error}</p> : null}
    </section>
  );
}

function InviteMemberForm({
  organizationId,
  isOwner,
}: {
  organizationId: string;
  isOwner: boolean;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('ADMIN');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/organizations/${organizationId}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not send the invite.');
      return;
    }
    const { token }: { id: string; token: string } = await res.json();
    setInviteUrl(`${window.location.origin}/organization-invites/${token}/accept`);
    setEmail('');
  }

  return (
    <form className="mt-4 space-y-3" onSubmit={(e) => void handleInvite(e)}>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="invite-email" className="block text-sm font-medium text-ink">
            Invite member
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink"
          />
        </div>
        <div>
          <label htmlFor="invite-role" className="block text-sm font-medium text-ink">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as OrgRole)}
            className="mt-1 rounded border border-line bg-paper px-3 py-2 text-sm text-ink"
          >
            <option value="ADMIN">ADMIN</option>
            {isOwner ? <option value="OWNER">OWNER</option> : null}
          </select>
        </div>
        <button
          type="submit"
          disabled={submitting || !email.trim()}
          className="rounded bg-cobalt px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Send invite
        </button>
      </div>
      {error ? <p className="text-sm text-red">{error}</p> : null}
      {inviteUrl ? (
        <p className="rounded border border-line bg-paper p-3 text-sm text-sub">
          Invite link: <span className="font-mono text-ink">{inviteUrl}</span>
        </p>
      ) : null}
    </form>
  );
}

function MemberRow({
  member,
  organizationId,
  isOwner,
  onOffboarded,
}: {
  member: Member;
  organizationId: string;
  isOwner: boolean;
  onOffboarded: (userId: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typedEmail, setTypedEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const matches = typedEmail === member.email;

  async function handleConfirm() {
    if (!matches) return;
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/organizations/${organizationId}/members/${member.userId}`, {
      method: 'DELETE',
    });
    setSubmitting(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not offboard this member.');
      return;
    }
    onOffboarded(member.userId);
  }

  return (
    <li className="rounded border border-line bg-paper px-3 py-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-ink">{member.name}</p>
          <p className="text-sm text-sub">
            {member.email} — {member.role}
          </p>
        </div>
        {isOwner ? (
          <button
            type="button"
            onClick={() => setConfirming((prev) => !prev)}
            className="text-sm font-medium text-red"
          >
            Offboard
          </button>
        ) : null}
      </div>
      {confirming ? (
        <div className="mt-3 rounded border border-amber bg-amber-soft p-3">
          <label htmlFor={`confirm-offboard-${member.userId}`} className="block text-sm text-amber">
            Type {member.email} to confirm offboarding
          </label>
          <input
            id={`confirm-offboard-${member.userId}`}
            type="text"
            value={typedEmail}
            onChange={(e) => setTypedEmail(e.target.value)}
            className="mt-1 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink"
          />
          <button
            type="button"
            disabled={!matches || submitting}
            onClick={() => void handleConfirm()}
            className="mt-2 rounded bg-red px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Confirm offboard
          </button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-sm text-red">{error}</p> : null}
    </li>
  );
}

function MembersSection({
  organizationId,
  initialMembers,
  isOwner,
}: {
  organizationId: string;
  initialMembers: Member[];
  isOwner: boolean;
}) {
  const [members, setMembers] = useState<Member[]>(initialMembers);

  function handleOffboarded(userId: string) {
    setMembers((prev) => prev.filter((m) => m.userId !== userId));
  }

  return (
    <section className="rounded-lg border border-line bg-panel p-6">
      <h2 className="text-lg font-semibold text-ink">Members</h2>
      <ul className="mt-4 space-y-2">
        {members.map((m) => (
          <MemberRow
            key={m.userId}
            member={m}
            organizationId={organizationId}
            isOwner={isOwner}
            onOffboarded={handleOffboarded}
          />
        ))}
        {members.length === 0 ? <p className="text-sm text-sub">No members yet.</p> : null}
      </ul>
      <InviteMemberForm organizationId={organizationId} isOwner={isOwner} />
    </section>
  );
}

export function OrgSettings({
  organizationId,
  initialName,
  initialSize,
  isOwner,
  initialWorkspaces,
  initialMembers,
}: {
  organizationId: string;
  initialName: string;
  initialSize: OrgSize | null;
  isOwner: boolean;
  // currentUserId is accepted for parity with the server page's props (and
  // potential future use — e.g. highlighting "you" in the member list) even
  // though the offboard flow itself doesn't special-case self-offboarding;
  // the backend's last-OWNER check covers that.
  currentUserId: string;
  initialWorkspaces: Workspace[];
  initialMembers: Member[];
}) {
  return (
    <div className="space-y-6">
      <OrgDetailsSection
        organizationId={organizationId}
        initialName={initialName}
        initialSize={initialSize}
        isOwner={isOwner}
      />
      <WorkspacesSection organizationId={organizationId} initialWorkspaces={initialWorkspaces} />
      <MembersSection
        organizationId={organizationId}
        initialMembers={initialMembers}
        isOwner={isOwner}
      />
    </div>
  );
}
