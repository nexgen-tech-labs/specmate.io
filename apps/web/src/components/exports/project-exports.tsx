'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface SnapshotRow {
  id: string;
  kind: string;
  created_at: string;
  item_count: number;
  source_count: number;
}

// Snapshot export + approval report controls (Issues 8.4/8.5).
export function ProjectExports({
  workspaceId,
  projectId,
  snapshots,
  canCreate,
}: {
  workspaceId: string;
  projectId: string;
  snapshots: SnapshotRow[];
  canCreate: boolean;
}) {
  const router = useRouter();
  const base = `/api/workspaces/${workspaceId}/projects/${projectId}`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  async function createSnapshot() {
    setBusy(true);
    setError(null);
    const res = await fetch(`${base}/snapshots`, { method: 'POST' });
    setBusy(false);
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      setError(payload.detail ?? payload.error ?? 'Snapshot creation failed.');
      return;
    }
    router.refresh();
  }

  const reportQs = new URLSearchParams();
  if (from) reportQs.set('from', from);
  if (to) reportQs.set('to', to);
  const reportBase = `${base}/approval-report${reportQs.toString() ? `?${reportQs}` : ''}`;
  const reportPdf = `${base}/approval-report?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), format: 'pdf' })}`;

  return (
    <div className="mt-6 space-y-8">
      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Trace snapshots</h2>
          {canCreate ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void createSnapshot()}
              className="rounded-md bg-cobalt px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create snapshot now'}
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-sub">
          Point-in-time export of the full trace map — immutable once generated, valid even if items
          are later edited or re-published.
        </p>
        {snapshots.length === 0 ? (
          <p className="mt-3 text-sm text-sub">No snapshots yet.</p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {snapshots.map((snap) => (
              <li
                key={snap.id}
                className="flex items-baseline gap-3 rounded-md border border-line bg-panel px-4 py-2.5 text-sm"
              >
                <span className="font-mono text-xs text-sub">
                  {new Date(snap.created_at).toLocaleString()}
                </span>
                <span className="text-ink">
                  {snap.item_count} items · {snap.source_count} sources
                </span>
                <span className="ml-auto flex gap-3 text-xs">
                  <a href={`${base}/snapshots/${snap.id}`} className="text-cobalt hover:underline">
                    JSON
                  </a>
                  <a
                    href={`${base}/snapshots/${snap.id}?format=pdf`}
                    className="text-cobalt hover:underline"
                  >
                    PDF
                  </a>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold text-ink">Approval report</h2>
        <p className="mt-1 text-xs text-sub">
          Who approved what, when, from which source — approved items only, formatted for a sign-off
          pack.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-1 text-sub">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-sub">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <a
            href={reportBase}
            className="rounded border border-line px-3 py-1.5 text-sm font-semibold text-ink"
          >
            View JSON
          </a>
          <a
            href={reportPdf}
            className="rounded-md bg-cobalt px-3 py-1.5 text-sm font-semibold text-white"
          >
            Download PDF
          </a>
        </div>
      </section>

      {error ? <p className="text-sm text-red">{error}</p> : null}
    </div>
  );
}
