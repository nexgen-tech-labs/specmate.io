'use client';

import { useState } from 'react';

type WorkspaceMember = { userId: string; name: string; email: string };
type Project = { id: string; name: string };

export function TeamDetail({
  workspaceId,
  teamId,
  allWorkspaceMembers,
  allProjects,
  initialMemberIds,
  initialProjectIds,
}: {
  workspaceId: string;
  teamId: string;
  allWorkspaceMembers: WorkspaceMember[];
  allProjects: Project[];
  initialMemberIds: string[];
  initialProjectIds: string[];
}) {
  const [baselineMemberIds, setBaselineMemberIds] = useState<string[]>(initialMemberIds);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(
    new Set(initialMemberIds),
  );
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(
    new Set(initialProjectIds),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function toggleMember(userId: string) {
    setSaved(false);
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }

  function toggleProject(projectId: string) {
    setSaved(false);
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    setSubmitting(true);

    const addMemberIds = [...selectedMemberIds].filter((id) => !baselineMemberIds.includes(id));
    const removeMemberIds = baselineMemberIds.filter((id) => !selectedMemberIds.has(id));
    const projectIds = [...selectedProjectIds];

    const res = await fetch(`/api/workspaces/${workspaceId}/teams/${teamId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addMemberIds, removeMemberIds, projectIds }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not save the team.');
      return;
    }

    setBaselineMemberIds([...selectedMemberIds]);
    setSaved(true);
  }

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-line bg-panel p-6">
        <h2 className="text-lg font-semibold text-ink">Members</h2>
        <ul className="mt-4 space-y-2">
          {allWorkspaceMembers.map((member) => (
            <li key={member.userId} className="flex items-center gap-2">
              <input
                id={`member-${member.userId}`}
                type="checkbox"
                checked={selectedMemberIds.has(member.userId)}
                onChange={() => toggleMember(member.userId)}
                className="h-4 w-4"
              />
              <label htmlFor={`member-${member.userId}`} className="text-sm text-ink">
                {member.name} <span className="text-sub">({member.email})</span>
              </label>
            </li>
          ))}
          {allWorkspaceMembers.length === 0 ? (
            <p className="text-sm text-sub">No workspace members yet.</p>
          ) : null}
        </ul>
      </section>

      <section className="rounded-lg border border-line bg-panel p-6">
        <h2 className="text-lg font-semibold text-ink">Project scope</h2>
        <p className="mt-1 text-sm text-sub">
          No projects selected = unscoped (team members see the whole workspace).
        </p>
        <ul className="mt-4 space-y-2">
          {allProjects.map((project) => (
            <li key={project.id} className="flex items-center gap-2">
              <input
                id={`project-${project.id}`}
                type="checkbox"
                checked={selectedProjectIds.has(project.id)}
                onChange={() => toggleProject(project.id)}
                className="h-4 w-4"
              />
              <label htmlFor={`project-${project.id}`} className="text-sm text-ink">
                {project.name}
              </label>
            </li>
          ))}
          {allProjects.length === 0 ? (
            <p className="text-sm text-sub">No projects in this workspace yet.</p>
          ) : null}
        </ul>
      </section>

      <div>
        <button
          type="button"
          disabled={submitting}
          onClick={() => void handleSave()}
          className="rounded bg-cobalt px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Save
        </button>
        {saved ? <p className="mt-2 text-sm text-ink">Saved.</p> : null}
        {error ? <p className="mt-2 text-sm text-red">{error}</p> : null}
      </div>
    </div>
  );
}
