'use client';

import { useEffect, useState } from 'react';
import type { DiscoveryResult, StepProps } from '../types';

export function ReviewDefaultsStep({
  workspaceId,
  projectId,
  toolKey,
  collectedState,
  onAdvance,
}: StepProps) {
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const remoteProject = collectedState.remote_project ?? '';

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      const res = await fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/connectors/${toolKey}/test`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remote_project: remoteProject }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as
        | (DiscoveryResult & { error?: string; detail?: string })
        | { error?: string; detail?: string };
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setError(
          (payload as { detail?: string; error?: string }).detail ??
            (payload as { detail?: string; error?: string }).error ??
            'Could not discover defaults for this scope.',
        );
        return;
      }
      setDiscovery(payload as DiscoveryResult);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, projectId, toolKey, remoteProject]);

  const extras = discovery?.extras ?? {};
  const labels = Array.isArray(extras.labels) ? (extras.labels as string[]) : [];
  const milestones = Array.isArray(extras.milestones)
    ? (extras.milestones as Array<{ title: string }>)
    : [];
  const filePaths = Array.isArray(extras.file_paths) ? (extras.file_paths as string[]) : [];

  return (
    <div className="rounded-lg border border-line bg-panel p-8">
      <h2 className="text-lg font-semibold text-ink">Review defaults</h2>
      <p className="mt-2 text-sm text-sub">
        Here&apos;s what SpecMate found for{' '}
        <span className="font-semibold text-ink">{remoteProject}</span>.
      </p>

      {loading ? <p className="mt-4 text-sm text-sub">Discovering…</p> : null}
      {error ? <p className="mt-4 text-sm text-red">{error}</p> : null}

      {discovery && discovery.item_types ? (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold text-ink">Item types</h3>
          <p className="mb-2 text-xs text-sub">
            These will be mapped automatically — you can fine-tune the mapping later from Settings.
          </p>
          <ul className="space-y-1 text-sm text-ink">
            {discovery.item_types.map((t) => (
              <li key={t.id} className="rounded border border-line px-3 py-2">
                <span className="font-semibold">{t.name}</span>
                {t.supports_children ? (
                  <span className="ml-2 text-xs text-sub">(supports children)</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {discovery && discovery.item_types === null ? (
        <div className="mt-5 text-xs text-sub">
          <p>
            <span className="font-semibold text-ink">{labels.length}</span> existing labels
            discovered · <span className="font-semibold text-ink">{milestones.length}</span>{' '}
            milestones · <span className="font-semibold text-ink">{filePaths.length}</span> files
            indexed for reference suggestions.
          </p>
        </div>
      ) : null}

      <div className="mt-6 flex justify-between">
        <button
          type="button"
          onClick={() => void onAdvance('select_scope')}
          className="text-sm text-sub underline-offset-2 hover:underline"
        >
          ← Back
        </button>
        <button
          type="button"
          disabled={!discovery}
          onClick={() => void onAdvance('test_connection', discovery ? { discovery } : undefined)}
          className="rounded-md bg-cobalt px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
