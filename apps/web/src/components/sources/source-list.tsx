'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  parseError: string | null;
  fragmentCount: number;
  updatedAt: string;
  // Issue 9.1/9.2/9.3: set when this Source is a new version of a previous upload —
  // surfaces the "regenerate delta" / "review delta" actions.
  isNewVersion: boolean;
  hasDiff: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  QUEUED: 'text-sub bg-paper',
  PARSING: 'text-cobalt bg-paper',
  PARSED: 'text-green bg-paper',
  FAILED: 'text-red bg-red-soft',
};

export function SourceList({
  workspaceId,
  projectId,
  sources,
}: {
  workspaceId: string;
  projectId: string;
  sources: SourceRow[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function targetedRegenerate(sourceId: string) {
    setBusyId(sourceId);
    setActionError(null);
    const res = await fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/sources/${sourceId}/targeted-regenerate`,
      { method: 'POST' },
    );
    setBusyId(null);
    if (!res.ok) {
      const body: { error?: string; detail?: string } = await res.json().catch(() => ({}));
      setActionError(body.detail ?? body.error ?? 'Targeted regeneration failed.');
      return;
    }
    router.push(
      `/workspaces/${workspaceId}/projects/${projectId}/sources/${sourceId}/delta-review`,
    );
  }

  async function reparse(sourceId: string) {
    setBusyId(sourceId);
    setActionError(null);
    const res = await fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/sources/${sourceId}/reparse`,
      { method: 'POST' },
    );
    if (!res.ok) {
      const body: { error?: string; detail?: string } = await res.json().catch(() => ({}));
      setActionError(body.detail ?? body.error ?? 'Re-parse failed.');
    }
    setBusyId(null);
    router.refresh();
  }

  async function remove(sourceId: string, name: string) {
    if (
      !window.confirm(`Delete "${name}"? Its extracted fragments will be removed from active use.`)
    ) {
      return;
    }
    setBusyId(sourceId);
    setActionError(null);
    const res = await fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/sources/${sourceId}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setActionError(body.error ?? 'Delete failed.');
    }
    setBusyId(null);
    router.refresh();
  }

  if (sources.length === 0) {
    return <p className="mt-6 text-sm text-sub">No sources yet — upload a document above.</p>;
  }

  return (
    <div className="mt-6">
      {actionError ? <p className="mb-3 text-sm text-red">{actionError}</p> : null}
      <ul className="space-y-2">
        {sources.map((source) => (
          <li key={source.id} className="rounded-md border border-line bg-panel px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="text-sm font-semibold text-ink">{source.name}</span>{' '}
                <span className="text-xs text-sub">
                  ({source.kind} · {source.fragmentCount} fragment
                  {source.fragmentCount === 1 ? '' : 's'})
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`rounded px-2 py-0.5 font-mono text-xs font-bold tracking-wide ${
                    STATUS_STYLES[source.status] ?? 'text-sub bg-paper'
                  }`}
                >
                  {source.status}
                </span>
                <button
                  type="button"
                  disabled={busyId === source.id}
                  onClick={() => void reparse(source.id)}
                  className="rounded border border-line px-2 py-0.5 text-xs text-ink hover:bg-paper disabled:opacity-50"
                >
                  {busyId === source.id ? 'Working…' : 'Re-parse'}
                </button>
                <button
                  type="button"
                  disabled={busyId === source.id}
                  onClick={() => void remove(source.id, source.name)}
                  className="rounded border border-line px-2 py-0.5 text-xs text-red hover:bg-red-soft disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
            {source.status === 'FAILED' && source.parseError ? (
              <p className="mt-2 text-xs text-red">{source.parseError}</p>
            ) : null}
            {source.isNewVersion && source.status === 'PARSED' ? (
              <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
                <span className="font-mono text-[10px] font-bold tracking-wide text-cobalt">
                  NEW VERSION
                </span>
                {source.hasDiff ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === source.id}
                      onClick={() => void targetedRegenerate(source.id)}
                      className="rounded border border-cobalt px-2 py-0.5 text-xs font-semibold text-cobalt hover:bg-cobalt-soft disabled:opacity-50"
                    >
                      {busyId === source.id ? 'Regenerating…' : 'Regenerate delta'}
                    </button>
                    <Link
                      href={`/workspaces/${workspaceId}/projects/${projectId}/sources/${source.id}/delta-review`}
                      className="text-xs text-cobalt underline-offset-2 hover:underline"
                    >
                      Review delta →
                    </Link>
                  </>
                ) : (
                  <span className="text-xs text-sub">Diff not ready yet.</span>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
