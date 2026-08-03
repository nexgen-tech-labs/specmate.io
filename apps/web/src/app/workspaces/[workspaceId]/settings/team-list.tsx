'use client';

import { useState } from 'react';
import Link from 'next/link';

type Team = { id: string; name: string; memberCount: number; projectScopeCount: number };

function TeamRow({
  team,
  workspaceId,
  onArchived,
}: {
  team: Team;
  workspaceId: string;
  onArchived: (teamId: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleArchive() {
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/teams/${team.id}`, {
      method: 'DELETE',
    });
    setSubmitting(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not archive the team.');
      return;
    }
    onArchived(team.id);
  }

  const scopeLabel =
    team.projectScopeCount === 0
      ? 'unscoped'
      : `${team.projectScopeCount} project${team.projectScopeCount === 1 ? '' : 's'} scoped`;

  return (
    <li className="rounded border border-line bg-paper px-3 py-2">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href={`/workspaces/${workspaceId}/teams/${team.id}`}
            className="text-sm font-medium text-cobalt"
          >
            {team.name}
          </Link>
          <p className="text-sm text-sub">
            {team.memberCount} member{team.memberCount === 1 ? '' : 's'} · {scopeLabel}
          </p>
        </div>
        <button
          type="button"
          disabled={submitting}
          onClick={() => void handleArchive()}
          className="text-sm font-medium text-red disabled:opacity-50"
        >
          Archive
        </button>
      </div>
      {error ? <p className="mt-2 text-sm text-red">{error}</p> : null}
    </li>
  );
}

export function TeamList({
  workspaceId,
  initialTeams,
}: {
  workspaceId: string;
  initialTeams: Team[];
}) {
  const [teams, setTeams] = useState<Team[]>(initialTeams);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not create the team.');
      return;
    }
    const created: { id: string; name: string } = await res.json();
    setTeams((prev) => [...prev, { ...created, memberCount: 0, projectScopeCount: 0 }]);
    setNewName('');
  }

  function handleArchived(teamId: string) {
    setTeams((prev) => prev.filter((t) => t.id !== teamId));
  }

  return (
    <section className="rounded-lg border border-line bg-panel p-6">
      <h2 className="text-lg font-semibold text-ink">Teams</h2>
      <ul className="mt-4 space-y-2">
        {teams.map((team) => (
          <TeamRow
            key={team.id}
            team={team}
            workspaceId={workspaceId}
            onArchived={handleArchived}
          />
        ))}
        {teams.length === 0 ? <p className="text-sm text-sub">No teams yet.</p> : null}
      </ul>
      <form className="mt-4 flex items-end gap-2" onSubmit={(e) => void handleCreate(e)}>
        <div className="flex-1">
          <label htmlFor="new-team-name" className="block text-sm font-medium text-ink">
            Create team
          </label>
          <input
            id="new-team-name"
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
