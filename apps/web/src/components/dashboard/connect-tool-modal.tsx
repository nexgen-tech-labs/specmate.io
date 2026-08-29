'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ModalShell } from '@/components/modals/modal-shell';

type Step = 'pick' | 'authorizing' | 'scope' | 'confirm';

interface ScopeOption {
  id: string;
  label: string;
}

const ORG_LEVEL_TOOLS = ['jira', 'github'] as const;
const TOOL_LABEL: Record<string, string> = { jira: 'Jira', ado: 'Azure DevOps', github: 'GitHub' };

export function ConnectToolModal({
  organizationId,
  workspaceId,
  onClose,
  /** Set when reopened after an OAuth return (?connect_tool=X&oauth=success)
   * — skips the tool picker and jumps straight to the scope step. */
  initialToolKey,
  /** The project publish-mapping is saved against — same default-project
   * resolution as Add Source/Generate. Null for a VIEWER; the scope step
   * still records the workspace's board/repo pick either way, but publishing
   * won't work until an ADMIN confirms a scope with a real project to map. */
  defaultProjectId,
}: {
  organizationId: string;
  workspaceId: string;
  onClose: () => void;
  initialToolKey?: string;
  defaultProjectId: string | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(initialToolKey ? 'scope' : 'pick');
  const [toolKey, setToolKey] = useState<string | null>(initialToolKey ?? null);
  const [error, setError] = useState<string | null>(null);
  const [mappingWarning, setMappingWarning] = useState<string | null>(null);

  async function startAuthorize(tool: string) {
    setToolKey(tool);
    setStep('authorizing');
    setError(null);
    try {
      const res = await fetch(`/api/organizations/${organizationId}/wizard-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_key: tool }),
      });
      if (!res.ok) {
        setError('Could not start authorization — try again.');
        setStep('pick');
        return;
      }
      const session = (await res.json()) as { id: string };
      window.location.href = `/api/connectors/${tool}/oauth/start?org_wizard_session_id=${encodeURIComponent(session.id)}`;
    } catch {
      setError('Could not reach the server — try again.');
      setStep('pick');
    }
  }

  return (
    <ModalShell title="Connect a tool" onClose={onClose}>
      {step === 'pick' ? (
        <ToolPicker onPick={(tool) => void startAuthorize(tool)} error={error} />
      ) : null}
      {step === 'authorizing' ? (
        <p className="text-sm text-sub">
          Redirecting you to {toolKey ? TOOL_LABEL[toolKey] : 'the provider'} to authorize…
        </p>
      ) : null}
      {step === 'scope' && toolKey ? (
        <ScopePicker
          organizationId={organizationId}
          workspaceId={workspaceId}
          projectId={defaultProjectId}
          toolKey={toolKey}
          onDone={(warning) => {
            setMappingWarning(warning);
            setStep('confirm');
          }}
        />
      ) : null}
      {step === 'confirm' ? (
        <div>
          <p className="text-sm text-ink">
            {toolKey ? TOOL_LABEL[toolKey] : 'This tool'} is connected for this workspace.
          </p>
          {mappingWarning ? <p className="mt-3 text-sm text-red">{mappingWarning}</p> : null}
          <button
            type="button"
            onClick={() => {
              router.refresh();
              onClose();
            }}
            className="mt-6 rounded-md bg-cobalt px-4 py-2.5 text-sm font-bold text-white"
          >
            Done
          </button>
        </div>
      ) : null}
    </ModalShell>
  );
}

function ToolPicker({ onPick, error }: { onPick: (tool: string) => void; error: string | null }) {
  return (
    <div>
      <p className="mb-4 text-sm text-sub">
        Authorize once at the organization — every workspace picks its own board or repo.
      </p>
      <div className="flex flex-col gap-2.5">
        {ORG_LEVEL_TOOLS.map((tool) => (
          <button
            key={tool}
            type="button"
            onClick={() => onPick(tool)}
            className="rounded-md border border-line bg-paper px-4 py-3 text-left text-sm font-semibold text-ink"
          >
            {TOOL_LABEL[tool]}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-sub">
        Azure DevOps connects per-workspace with a personal access token — set it up from a
        project&apos;s connector settings.
      </p>
      {error ? <p className="mt-4 text-sm text-red">{error}</p> : null}
    </div>
  );
}

function ScopePicker({
  organizationId,
  workspaceId,
  projectId,
  toolKey,
  onDone,
}: {
  organizationId: string;
  workspaceId: string;
  projectId: string | null;
  toolKey: string;
  onDone: (mappingWarning: string | null) => void;
}) {
  const [options, setOptions] = useState<ScopeOption[] | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch(
        `/api/organizations/${organizationId}/connectors/${toolKey}/scope-options`,
      );
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not discover available scopes.');
        return;
      }
      const body = (await res.json()) as { connection_id: string; scope_options: ScopeOption[] };
      setOptions(body.scope_options);
      setConnectionId(body.connection_id);
      if (body.scope_options.length > 0) setSelected(body.scope_options[0].id);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId, toolKey]);

  async function handleConfirm() {
    const option = options?.find((o) => o.id === selected);
    if (!option || !connectionId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/connector-scope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId,
          scopeValue: option.id,
          scopeLabel: option.label,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not save your selection.');
        return;
      }

      // Publishing needs a project-level PublishMapping (remote_project +
      // type map), a separate concept from the workspace's scope pick above
      // — create/refresh it now so publishing works immediately, with no
      // separate manual step through the old per-project connector settings
      // page. Best-effort: the org connection + workspace scope are already
      // saved at this point, so a mapping failure here (e.g. no project yet)
      // surfaces as a warning, not a blocker to calling this tool "connected."
      if (projectId && (toolKey === 'jira' || toolKey === 'github')) {
        const mappingRes = await fetch(
          `/api/workspaces/${workspaceId}/projects/${projectId}/publish-mapping/${toolKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ remote_project: option.id }),
          },
        );
        if (!mappingRes.ok) {
          const body = (await mappingRes.json().catch(() => ({}))) as {
            error?: string;
            detail?: string;
          };
          onDone(
            body.detail ?? body.error ?? 'Connected, but publishing setup needs another look.',
          );
          return;
        }
      }

      onDone(null);
    } catch {
      setError('Could not reach the server — try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-sub">Discovering available scopes…</p>;

  if (error && !options) {
    return <p className="text-sm text-red">{error}</p>;
  }

  if (!options || options.length === 0) {
    return <p className="text-sm text-sub">No boards or repos found for this connection.</p>;
  }

  return (
    <div>
      <label htmlFor="tool-scope" className="mb-2 block text-sm font-semibold text-ink">
        {toolKey === 'jira' ? 'Board' : 'Repository'}
      </label>
      <select
        id="tool-scope"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="w-full rounded-md border border-line bg-paper px-3.5 py-2.5 text-sm text-ink"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={saving}
          className="rounded-md bg-cobalt px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}
