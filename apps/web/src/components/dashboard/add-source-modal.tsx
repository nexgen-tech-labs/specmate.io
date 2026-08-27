'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ModalShell } from '@/components/modals/modal-shell';
import { UploadZone } from '@/components/sources/upload-zone';

type Tab = 'upload' | 'paste' | 'connector';

interface ConnectorScope {
  connectionId: string;
  toolKey: string;
  scopeValue: string;
  scopeLabel: string;
}

const TOOL_LABEL: Record<string, string> = { jira: 'Jira', ado: 'Azure DevOps', github: 'GitHub' };

export function AddSourceModal({
  workspaceId,
  projectId,
  onClose,
}: {
  workspaceId: string;
  projectId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('upload');

  return (
    <ModalShell title="Add a source" onClose={onClose} maxWidthClassName="max-w-xl">
      <div className="mb-5 flex gap-1 rounded-md bg-paper p-1">
        {(['upload', 'paste', 'connector'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex-1 rounded-[6px] px-3 py-2 text-sm font-semibold ${
              tab === t ? 'bg-panel text-ink shadow-sm' : 'text-sub'
            }`}
          >
            {t === 'upload' ? 'Upload a file' : t === 'paste' ? 'Paste text' : 'Pull from a tool'}
          </button>
        ))}
      </div>

      {tab === 'upload' ? (
        <UploadZone
          workspaceId={workspaceId}
          projectId={projectId}
          onUploaded={() => {
            router.refresh();
            onClose();
          }}
        />
      ) : null}

      {tab === 'paste' ? (
        <PasteTextForm
          workspaceId={workspaceId}
          projectId={projectId}
          onDone={() => {
            router.refresh();
            onClose();
          }}
        />
      ) : null}

      {tab === 'connector' ? (
        <PullFromConnectorForm
          workspaceId={workspaceId}
          projectId={projectId}
          onDone={() => {
            router.refresh();
            onClose();
          }}
        />
      ) : null}
    </ModalShell>
  );
}

function PasteTextForm({
  workspaceId,
  projectId,
  onDone,
}: {
  workspaceId: string;
  projectId: string;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/sources/from-text`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() || undefined, text }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not save the pasted text.');
        return;
      }
      onDone();
    } catch {
      setError('Could not reach the server — try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        className="mb-3 w-full rounded-md border border-line bg-paper px-3.5 py-2.5 text-sm text-ink"
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste a transcript, doc, or backlog dump…"
        rows={8}
        className="w-full rounded-md border border-line bg-paper px-3.5 py-2.5 text-sm text-ink"
      />
      {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!text.trim() || saving}
          className="rounded-md bg-cobalt px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Add source'}
        </button>
      </div>
    </div>
  );
}

function PullFromConnectorForm({
  workspaceId,
  projectId,
  onDone,
}: {
  workspaceId: string;
  projectId: string;
  onDone: () => void;
}) {
  const [scopes, setScopes] = useState<ConnectorScope[] | null>(null);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch(`/api/workspaces/${workspaceId}/connector-scope`);
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        setError('Could not load your connected tools.');
        return;
      }
      const body = (await res.json()) as { scopes: ConnectorScope[] };
      setScopes(body.scopes);
      if (body.scopes.length > 0) setSelected(body.scopes[0].connectionId);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function handlePull() {
    const scope = scopes?.find((s) => s.connectionId === selected);
    if (!scope) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/sources/from-connector`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: scope.toolKey, remote: scope.scopeValue }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not pull the backlog.');
        return;
      }
      onDone();
    } catch {
      setError('Could not reach the server — try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-sub">Loading your connected tools…</p>;

  if (!scopes || scopes.length === 0) {
    return (
      <p className="text-sm text-sub">
        No tools connected yet. Use &quot;Connect a tool&quot; first, then come back here to pull
        its backlog in as a source.
      </p>
    );
  }

  return (
    <div>
      <label htmlFor="connector-scope" className="mb-2 block text-sm font-semibold text-ink">
        Board / repo
      </label>
      <select
        id="connector-scope"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="w-full rounded-md border border-line bg-paper px-3.5 py-2.5 text-sm text-ink"
      >
        {scopes.map((s) => (
          <option key={s.connectionId} value={s.connectionId}>
            {TOOL_LABEL[s.toolKey] ?? s.toolKey} · {s.scopeLabel}
          </option>
        ))}
      </select>
      {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={() => void handlePull()}
          disabled={saving}
          className="rounded-md bg-cobalt px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {saving ? 'Pulling…' : 'Pull backlog'}
        </button>
      </div>
    </div>
  );
}
