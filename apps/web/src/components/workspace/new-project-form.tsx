'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Project creation (Issue 10.10). When `redirectToWizard` is set (the empty-state
// case — a brand-new workspace's first project), the new project routes straight
// into the guided onboarding wizard instead of the plain review/sources page.
export function NewProjectForm({
  workspaceId,
  redirectToWizard = false,
}: {
  workspaceId: string;
  redirectToWizard?: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? 'Could not create project.');
      return;
    }
    const project = (await res.json()) as { id: string };
    router.push(
      redirectToWizard
        ? `/workspaces/${workspaceId}/projects/${project.id}/get-started`
        : `/workspaces/${workspaceId}/projects/${project.id}/sources`,
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="flex justify-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name, e.g. Payments Portal"
          className="w-64 rounded-md border border-line bg-paper px-4 py-2.5 text-base text-ink"
        />
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-md bg-cobalt px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
      {error ? <p className="mt-2 text-center text-sm text-red">{error}</p> : null}
    </form>
  );
}
