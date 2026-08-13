'use client';

import type { StepProps } from '../types';

// Display-only recap of what review-defaults already discovered — no new
// network call, per the plan (Issue #101, Task 9).
export function TestConnectionStep({ collectedState, onAdvance }: StepProps) {
  const discovery = collectedState.discovery;
  const remoteProject = collectedState.remote_project ?? '';

  return (
    <div className="rounded-lg border border-line bg-panel p-8">
      <h2 className="text-lg font-semibold text-ink">Does this look right?</h2>
      <p className="mt-2 text-sm text-sub">
        SpecMate will publish to <span className="font-semibold text-ink">{remoteProject}</span>.
      </p>

      {discovery ? (
        <div className="mt-5 rounded-md border border-line bg-paper p-4 text-sm text-ink">
          {discovery.item_types ? (
            <p>
              <span className="font-semibold">{discovery.item_types.length}</span> item type
              {discovery.item_types.length === 1 ? '' : 's'} discovered.
            </p>
          ) : (
            <p>
              <span className="font-semibold">{discovery.scope_options.length}</span> scope option
              {discovery.scope_options.length === 1 ? '' : 's'} discovered.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-sub">No discovery data was carried forward.</p>
      )}

      <div className="mt-6 flex justify-between">
        <button
          type="button"
          onClick={() => void onAdvance('review_defaults')}
          className="text-sm text-sub underline-offset-2 hover:underline"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={() => void onAdvance('confirm')}
          className="rounded-md bg-cobalt px-4 py-2 text-sm font-semibold text-white"
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
