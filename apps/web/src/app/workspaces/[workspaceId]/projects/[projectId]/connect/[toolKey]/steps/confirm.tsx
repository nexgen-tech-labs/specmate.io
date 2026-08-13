'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { StepProps } from '../types';

// The settings page slug doesn't follow "publishing-{toolKey}" for Jira (it's
// just "publishing", predating the github/ado variants) — map explicitly
// rather than assuming a pattern.
const SETTINGS_PATH: Record<string, string> = {
  jira: 'publishing',
  ado: 'publishing-ado',
  github: 'publishing-github',
};

// Only jira/github/ado have existing publish-mapping proxy routes in
// apps/web today (all three do, as of Issue #101) — kept as an explicit map
// rather than assumed, so a future connector without a wired proxy route
// fails safely into the "not yet wired" state below instead of a raw fetch
// error.
const SUPPORTED_TOOLS = new Set(['jira', 'ado', 'github']);

export function ConfirmStep({ workspaceId, projectId, toolKey, collectedState }: StepProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remoteProject = collectedState.remote_project ?? '';

  if (!SUPPORTED_TOOLS.has(toolKey)) {
    return (
      <div className="rounded-lg border border-line bg-panel p-8">
        <h2 className="text-lg font-semibold text-ink">Not yet wired</h2>
        <p className="mt-2 text-sm text-sub">
          Saving a mapping for &quot;{toolKey}&quot; isn&apos;t available from the guided setup
          wizard yet — use the connector&apos;s settings page directly.
        </p>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/publish-mapping/${toolKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remote_project: remoteProject,
          format_mode: 'HUMAN',
        }),
      },
    );
    setSaving(false);
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      setError(payload.detail ?? payload.error ?? 'Saving the connection failed.');
      return;
    }
    router.push(
      `/workspaces/${workspaceId}/projects/${projectId}/settings/${SETTINGS_PATH[toolKey]}`,
    );
  }

  return (
    <div className="rounded-lg border border-line bg-panel p-8">
      <h2 className="text-lg font-semibold text-ink">Confirm connection</h2>
      <p className="mt-2 text-sm text-sub">
        Save <span className="font-semibold text-ink">{remoteProject}</span> as this project&apos;s
        publish destination.
      </p>

      {error ? <p className="mt-4 text-sm text-red">{error}</p> : null}

      <div className="mt-6 flex justify-end">
        <button
          type="button"
          disabled={saving || !remoteProject}
          onClick={() => void save()}
          className="rounded-md bg-cobalt px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save & finish →'}
        </button>
      </div>
    </div>
  );
}
