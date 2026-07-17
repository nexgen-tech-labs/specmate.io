'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface DriftFlagRow {
  id: string;
  externalKey: string;
  tool: string;
  itemTitle: string;
  diff: Record<string, { before: string; after: string }>;
  detectedAt: string;
}

export function DriftPanel({
  workspaceId,
  projectId,
  openFlags,
}: {
  workspaceId: string;
  projectId: string;
  openFlags: DriftFlagRow[];
}) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function checkDrift() {
    setChecking(true);
    setError(null);
    setResult(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/projects/${projectId}/drift-check`, {
      method: 'POST',
    });
    setChecking(false);
    const body: { drifted_count?: number; error?: string; detail?: string } = await res
      .json()
      .catch(() => ({}));
    if (!res.ok) {
      setError(body.detail ?? body.error ?? 'Drift check failed.');
      return;
    }
    setResult(
      body.drifted_count === 0
        ? 'No drift detected — all published issues match SpecMate’s records.'
        : `${body.drifted_count} item(s) drifted since last sync.`,
    );
    router.refresh();
  }

  async function resolve(flagId: string, resolution: 'ACCEPT_EXTERNAL' | 'REASSERT_SPECMATE') {
    setResolvingId(flagId);
    setError(null);
    const res = await fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/drift-flags/${flagId}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution }),
      },
    );
    setResolvingId(null);
    if (!res.ok) {
      const body: { error?: string; detail?: string } = await res.json().catch(() => ({}));
      setError(body.detail ?? body.error ?? 'Could not resolve drift.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="mb-8 rounded-md border border-line bg-panel p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-ink">External drift</h2>
          <p className="mt-1 text-xs text-sub">
            Checks whether published Jira/ADO/GitHub issues were edited outside SpecMate.
          </p>
        </div>
        <button
          type="button"
          disabled={checking}
          onClick={() => void checkDrift()}
          className="rounded border border-line px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Check for drift'}
        </button>
      </div>
      {result ? <p className="mt-2 text-xs text-sub">{result}</p> : null}
      {error ? <p className="mt-2 text-xs text-red">{error}</p> : null}

      {openFlags.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {openFlags.map((flag) => (
            <li key={flag.id} className="rounded border border-amber bg-amber-soft p-3 text-xs">
              <p className="font-mono font-bold text-amber">
                DRIFT — {flag.tool} {flag.externalKey}
              </p>
              <p className="mt-1 text-ink">{flag.itemTitle}</p>
              {Object.entries(flag.diff).map(([field, change]) => (
                <div key={field} className="mt-1">
                  <span className="font-mono text-[10px] font-bold text-sub uppercase">
                    {field}
                  </span>
                  <p className="text-sub">
                    SpecMate: <span className="text-ink">{change.before}</span>
                  </p>
                  <p className="text-sub">
                    External: <span className="text-ink">{change.after}</span>
                  </p>
                </div>
              ))}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={resolvingId === flag.id}
                  onClick={() => void resolve(flag.id, 'ACCEPT_EXTERNAL')}
                  className="rounded border border-line px-2 py-1 font-semibold text-ink disabled:opacity-50"
                >
                  Accept external change
                </button>
                <button
                  type="button"
                  disabled={resolvingId === flag.id}
                  onClick={() => void resolve(flag.id, 'REASSERT_SPECMATE')}
                  className="rounded border border-cobalt px-2 py-1 font-semibold text-cobalt disabled:opacity-50"
                >
                  Reassert SpecMate&apos;s version
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
