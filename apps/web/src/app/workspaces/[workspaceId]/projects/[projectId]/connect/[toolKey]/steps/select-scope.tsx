'use client';

import { useEffect, useState } from 'react';
import type { ScopeOption, StepProps } from '../types';

export function SelectScopeStep({ workspaceId, projectId, toolKey, onAdvance }: StepProps) {
  const [options, setOptions] = useState<ScopeOption[] | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
          body: JSON.stringify({}),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as {
        scope_options?: ScopeOption[];
        error?: string;
        detail?: string;
      };
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setError(payload.detail ?? payload.error ?? 'Could not discover available scopes.');
        return;
      }
      const opts = payload.scope_options ?? [];
      setOptions(opts);
      if (opts.length > 0) setSelected(opts[0].id);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, projectId, toolKey]);

  return (
    <div className="rounded-lg border border-line bg-panel p-8">
      <h2 className="text-lg font-semibold text-ink">Select scope</h2>
      <p className="mt-2 text-sm text-sub">
        Choose the project or repository SpecMate should publish items to.
      </p>

      {loading ? <p className="mt-4 text-sm text-sub">Discovering available scopes…</p> : null}
      {error ? <p className="mt-4 text-sm text-red">{error}</p> : null}

      {options && options.length > 0 ? (
        <div className="mt-5">
          <label htmlFor="scope" className="mb-2 block text-sm font-semibold text-ink">
            Scope
          </label>
          <select
            id="scope"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full max-w-md rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {options && options.length === 0 ? (
        <p className="mt-4 text-sm text-sub">No scopes were discovered for this connector.</p>
      ) : null}

      <div className="mt-6 flex justify-end">
        <button
          type="button"
          disabled={!selected}
          onClick={() => void onAdvance('review_defaults', { remote_project: selected })}
          className="rounded-md bg-cobalt px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
