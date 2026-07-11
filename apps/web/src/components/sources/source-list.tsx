'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  parseError: string | null;
  fragmentCount: number;
  updatedAt: string;
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
          </li>
        ))}
      </ul>
    </div>
  );
}
