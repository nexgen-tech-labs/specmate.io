'use client';

import { useEffect, useState } from 'react';

interface ItemTrace {
  item: { id: string; type: string; title: string; status: string };
  published: Array<{ key: string; url: string; tool: string; at: string }>;
  decisions: Array<{
    decision: string;
    actorName: string | null;
    actorEmail: string | null;
    notes: string | null;
    createdAt: string;
  }>;
  sources: Array<{
    sourceId: string;
    sourceName: string;
    rawRequirementId: string;
    sectionPath: string;
    excerpt: string;
  }>;
}

// Full trace chain for one item (Issue 8.3), rendered inline in the review queue —
// source → item → external key without leaving the page.
export function TracePanel({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const [trace, setTrace] = useState<ItemTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/trace?item=${itemId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Trace lookup failed.');
        const payload = (await res.json()) as { trace: ItemTrace };
        if (!cancelled) setTrace(payload.trace);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, itemId]);

  if (error) return <p className="mt-2 text-xs text-red">{error}</p>;
  if (!trace) return <p className="mt-2 text-xs text-sub">Loading trace…</p>;

  return (
    <div className="mt-3 rounded border border-line bg-paper p-3 text-xs">
      <p className="font-mono font-bold text-sub">FULL TRACE</p>

      <p className="mt-2 font-bold text-sub">Sources ({trace.sources.length})</p>
      {trace.sources.length === 0 ? (
        <p className="text-sub">No source citations recorded (noTrace item).</p>
      ) : (
        trace.sources.map((s) => (
          <p key={s.rawRequirementId} className="mt-0.5 text-ink">
            <span className="font-semibold">{s.sourceName}</span>{' '}
            <span className="font-mono text-sub">({s.sectionPath})</span> — “{s.excerpt}”
          </p>
        ))
      )}

      <p className="mt-2 font-bold text-sub">Review decisions ({trace.decisions.length})</p>
      {trace.decisions.map((d, i) => (
        <p key={i} className="mt-0.5 text-ink">
          {d.decision} by {d.actorName ?? d.actorEmail ?? 'unknown'} —{' '}
          {new Date(d.createdAt).toLocaleString()}
          {d.notes ? ` · ${d.notes}` : ''}
        </p>
      ))}
      {trace.decisions.length === 0 ? <p className="text-sub">No decisions yet.</p> : null}

      <p className="mt-2 font-bold text-sub">Published as</p>
      {trace.published.length === 0 ? (
        <p className="text-sub">Not published yet.</p>
      ) : (
        trace.published.map((p) => (
          <p key={`${p.tool}-${p.key}`} className="mt-0.5">
            <a
              href={p.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono font-bold text-cobalt"
            >
              {p.key} ↗
            </a>{' '}
            <span className="text-sub">
              ({p.tool}, {new Date(p.at).toLocaleString()})
            </span>
          </p>
        ))
      )}
    </div>
  );
}
