'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Metadata {
  labels?: string[];
  milestones?: Array<{ number: number; title: string }>;
  file_paths?: string[];
}

interface MappingState {
  remoteProject: string;
  formatMode: string;
  metadata: Metadata | null;
}

export function GithubPublishingSettings({
  workspaceId,
  projectId,
  initial,
}: {
  workspaceId: string;
  projectId: string;
  initial: MappingState | null;
}) {
  const router = useRouter();
  const base = `/api/workspaces/${workspaceId}/projects/${projectId}/publish-mapping/github`;
  const [remoteProject, setRemoteProject] = useState(initial?.remoteProject ?? '');
  const [formatMode, setFormatMode] = useState(initial?.formatMode ?? 'HUMAN');
  const [milestone, setMilestone] = useState<string>('');
  const [mapping, setMapping] = useState<MappingState | null>(initial);
  const [suggestedMode, setSuggestedMode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remote_project: remoteProject.trim(),
        format_mode: formatMode,
        milestone: milestone ? Number(milestone) : undefined,
      }),
    });
    setBusy(false);
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
      metadata?: Metadata;
      suggested_format_mode?: string;
    };
    if (!res.ok) {
      setError(payload.detail ?? payload.error ?? 'Saving the mapping failed.');
      return;
    }
    setMapping({
      remoteProject: remoteProject.trim(),
      formatMode,
      metadata: payload.metadata ?? null,
    });
    setSuggestedMode(payload.suggested_format_mode ?? null);
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="mt-6 space-y-5">
      <div>
        <label htmlFor="remote" className="mb-2 block text-base font-semibold text-ink">
          Repository (owner/name)
        </label>
        <div className="flex gap-2">
          <input
            id="remote"
            value={remoteProject}
            onChange={(e) => setRemoteProject(e.target.value)}
            placeholder="e.g. acme/payments"
            className="w-64 rounded-md border border-line bg-panel px-4 py-2.5 text-base text-ink"
          />
          <button
            type="button"
            disabled={busy || !remoteProject.trim()}
            onClick={() => void save()}
            className="rounded-md bg-cobalt px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {mapping ? 'Refresh from GitHub' : 'Connect'}
          </button>
        </div>
        <p className="mt-1 text-xs text-sub">
          GitHub Issues has no native type hierarchy — items publish as issues tagged with a{' '}
          <code>specmate:type</code> label. Discovery pulls real labels, milestones, and the
          repo&apos;s file tree (for Coding Agent mode file references).
        </p>
      </div>

      <div>
        <h2 className="mb-2 text-base font-semibold text-ink">Ticket format mode</h2>
        <div className="flex gap-3">
          {(['HUMAN', 'CODING_AGENT'] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-1.5 text-sm text-ink">
              <input
                type="radio"
                name="format-mode"
                checked={formatMode === mode}
                onChange={() => setFormatMode(mode)}
              />
              {mode === 'HUMAN' ? 'Human' : 'Coding Agent'}
            </label>
          ))}
        </div>
        {suggestedMode === 'CODING_AGENT' && formatMode !== 'CODING_AGENT' ? (
          <p className="mt-2 text-xs text-cobalt">
            💡 GitHub is a natural fit for coding-agent workflows — consider Coding Agent mode for
            structured, testable issues with file references. Human mode stays the default until
            validated with early users.
          </p>
        ) : null}
        {formatMode === 'CODING_AGENT' ? (
          <p className="mt-2 text-xs text-sub">
            Issues will include explicit scope, a testable AC checklist, best-effort file/module
            references from the repo, and a machine-checkable definition of done.
          </p>
        ) : null}
      </div>

      {mapping ? (
        <>
          <div>
            <label htmlFor="milestone" className="mb-1 block text-sm font-semibold text-ink">
              Default milestone
            </label>
            <select
              id="milestone"
              value={milestone}
              onChange={(e) => setMilestone(e.target.value)}
              className="w-full max-w-xs rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink"
            >
              <option value="">(none)</option>
              {(mapping.metadata?.milestones ?? []).map((m) => (
                <option key={m.number} value={m.number}>
                  {m.title}
                </option>
              ))}
            </select>
          </div>

          <div className="text-xs text-sub">
            <p>
              <span className="font-semibold text-ink">
                {mapping.metadata?.labels?.length ?? 0}
              </span>{' '}
              existing labels discovered ·{' '}
              <span className="font-semibold text-ink">
                {mapping.metadata?.file_paths?.length ?? 0}
              </span>{' '}
              files indexed for reference suggestions
            </p>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-md bg-cobalt px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            Save mapping
          </button>
        </>
      ) : null}

      {error ? <p className="text-sm text-red">{error}</p> : null}
      {saved ? <p className="text-sm text-green">Mapping saved.</p> : null}
    </div>
  );
}
