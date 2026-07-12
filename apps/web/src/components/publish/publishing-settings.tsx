'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Metadata {
  issue_types?: Array<{
    name: string;
    fields: Array<{ id: string; name: string; required: boolean; has_default: boolean }>;
  }>;
}

interface MappingState {
  remoteProject: string;
  typeMap: Record<string, string>;
  fieldDefaults: Record<string, unknown>;
  metadata: Metadata | null;
}

const SPECMATE_TYPES = [
  'EPIC',
  'STORY',
  'TASK',
  'SUBTASK',
  'ACCEPTANCE_CRITERIA',
  'TEST',
  'RISK',
  'NFR',
  'DEPENDENCY',
  'ASSUMPTION',
  'QUESTION',
];

export function PublishingSettings({
  workspaceId,
  projectId,
  initial,
}: {
  workspaceId: string;
  projectId: string;
  initial: MappingState | null;
}) {
  const router = useRouter();
  const base = `/api/workspaces/${workspaceId}/projects/${projectId}/publish-mapping/jira`;
  const [remoteProject, setRemoteProject] = useState(initial?.remoteProject ?? '');
  const [mapping, setMapping] = useState<MappingState | null>(initial);
  const [defaultsJson, setDefaultsJson] = useState(
    JSON.stringify(initial?.fieldDefaults ?? {}, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(typeMap?: Record<string, string>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    let fieldDefaults: Record<string, unknown>;
    try {
      fieldDefaults = JSON.parse(defaultsJson || '{}');
    } catch {
      setError('Fixed field defaults must be valid JSON.');
      setBusy(false);
      return;
    }
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remote_project: remoteProject.trim(),
        type_map: typeMap,
        field_defaults: fieldDefaults,
      }),
    });
    setBusy(false);
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
      type_map?: Record<string, string>;
      metadata?: Metadata;
    };
    if (!res.ok) {
      setError(payload.detail ?? payload.error ?? 'Saving the mapping failed.');
      return;
    }
    setMapping({
      remoteProject: remoteProject.trim(),
      typeMap: payload.type_map ?? {},
      fieldDefaults,
      metadata: payload.metadata ?? null,
    });
    setSaved(true);
    router.refresh();
  }

  const jiraTypes = mapping?.metadata?.issue_types?.map((t) => t.name) ?? [];
  const requiredWarnings =
    mapping?.metadata?.issue_types?.flatMap((t) =>
      t.fields
        .filter(
          (f) =>
            f.required &&
            !f.has_default &&
            !['summary', 'description', 'project', 'issuetype', 'parent', 'reporter'].includes(
              f.id,
            ) &&
            !(f.id in (mapping?.fieldDefaults ?? {})),
        )
        .map((f) => `${t.name}: "${f.name}" (${f.id}) is required — set a fixed default below`),
    ) ?? [];

  return (
    <div className="mt-6 space-y-5">
      <div>
        <label htmlFor="remote" className="mb-2 block text-base font-semibold text-ink">
          Jira project key
        </label>
        <div className="flex gap-2">
          <input
            id="remote"
            value={remoteProject}
            onChange={(e) => setRemoteProject(e.target.value)}
            placeholder="e.g. KAN"
            className="w-40 rounded-md border border-line bg-panel px-4 py-2.5 text-base text-ink"
          />
          <button
            type="button"
            disabled={busy || !remoteProject.trim()}
            onClick={() => void save(undefined)}
            className="rounded-md bg-cobalt px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {mapping ? 'Refresh from Jira' : 'Connect & suggest defaults'}
          </button>
        </div>
        <p className="mt-1 text-xs text-sub">
          Discovery pulls the project&apos;s real issue types and required fields; a default mapping
          is suggested automatically.
        </p>
      </div>

      {mapping ? (
        <>
          <div>
            <h2 className="mb-2 text-base font-semibold text-ink">Item type mapping</h2>
            <div className="space-y-1.5">
              {SPECMATE_TYPES.map((t) => (
                <div key={t} className="flex items-center gap-3 text-sm">
                  <span className="w-52 font-mono text-xs text-sub">{t}</span>
                  <span className="text-sub">→</span>
                  <select
                    value={mapping.typeMap[t] ?? ''}
                    onChange={(e) =>
                      setMapping({
                        ...mapping,
                        typeMap: { ...mapping.typeMap, [t]: e.target.value },
                      })
                    }
                    className="rounded border border-line bg-panel px-2 py-1 text-sm text-ink"
                  >
                    <option value="">(don&apos;t publish)</option>
                    {jiraTypes.map((jt) => (
                      <option key={jt} value={jt}>
                        {jt}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          {requiredWarnings.length > 0 ? (
            <div className="rounded-md border border-line bg-red-soft p-3 text-xs text-red">
              {requiredWarnings.map((w) => (
                <p key={w}>⚠ {w}</p>
              ))}
            </div>
          ) : null}

          <div>
            <h2 className="mb-2 text-base font-semibold text-ink">
              Fixed defaults for required Jira fields
            </h2>
            <textarea
              value={defaultsJson}
              onChange={(e) => setDefaultsJson(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-line bg-panel px-3 py-2 font-mono text-xs text-ink"
              placeholder='{"customfield_10020": "Backend"}'
            />
            <p className="mt-1 text-xs text-sub">
              JSON of Jira field id → value, applied to every published issue (for mandatory fields
              SpecMate has no natural value for).
            </p>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void save(mapping.typeMap)}
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
