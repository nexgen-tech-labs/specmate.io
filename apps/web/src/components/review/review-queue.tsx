'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { TracePanel } from '@/components/review/trace-panel';

export interface ReviewItem {
  id: string;
  type: string;
  title: string;
  description: string;
  status: string;
  qualityScore: number | null;
  scoreDetail: {
    completeness?: number;
    clarity?: number;
    testability?: number;
    specificity?: number;
    rationale?: string;
  } | null;
  flags: {
    duplicate?: { key: string; tool: string; confidence: number };
    gap?: { question: string };
    noTrace?: boolean;
    publishError?: string;
  } | null;
  parentId: string | null;
  signedOff: boolean;
  originalDraft: { title?: string; description?: string } | null;
  editHistory: Array<{ at: string; field: string; before: unknown; after: unknown }>;
  sources: Array<{ label: string; text: string }>;
  publishedKey: string | null;
  publishedUrl: string | null;
  duplicateReference: { title: string; description: string; state: string } | null;
  // Issue 9.3: present only in the delta review queue — what changed in the source
  // and (for revised items) the previous item's title/description side-by-side.
  deltaContext?: {
    reason: 'new' | 'modified' | 'removed';
    sourceName: string;
    changedFragmentText: string;
    previousVersion: { title: string; description: string } | null;
  } | null;
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'text-sub',
  APPROVED: 'text-green',
  REJECTED: 'text-red',
  EDITED: 'text-cobalt',
};

function ScoreBar({ score }: { score: number | null }) {
  if (score === null) return <span className="text-xs text-sub">—</span>;
  const color = score >= 75 ? 'bg-green' : score >= 60 ? 'bg-cobalt' : 'bg-red';
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-line">
        <span className={`block h-full ${color}`} style={{ width: `${score}%` }} />
      </span>
      <span className="font-mono text-xs text-sub">{score}</span>
    </span>
  );
}

export function ReviewQueue({
  workspaceId,
  projectId,
  items,
  canReview,
  isAdmin,
  approvalStages,
  activeFilters,
}: {
  workspaceId: string;
  projectId: string;
  items: ReviewItem[];
  canReview: boolean;
  isAdmin: boolean;
  approvalStages: number;
  activeFilters: { type?: string; status?: string; flagged?: string; sort?: string };
}) {
  const router = useRouter();
  const base = `/api/workspaces/${workspaceId}/projects/${projectId}/draft-items`;
  const pageBase = `/workspaces/${workspaceId}/projects/${projectId}/review`;
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editDraft, setEditDraft] = useState<{ title: string; description: string } | null>(null);
  const [gapAnswer, setGapAnswer] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [traceItemId, setTraceItemId] = useState<string | null>(null);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());

  async function flagRemoved(itemId: string): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await fetch(`${base}/${itemId}/flag-removed`, { method: 'POST' });
    setBusy(false);
    if (!res.ok) {
      const payload: { error?: string; detail?: string } = await res.json().catch(() => ({}));
      setError(payload.detail ?? payload.error ?? 'Could not flag the external issue.');
      return;
    }
    setFlaggedIds((prev) => new Set(prev).add(itemId));
  }

  async function call(url: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const payload: { error?: string } = await res.json().catch(() => ({}));
      setError(payload.error ?? 'Action failed.');
      return false;
    }
    router.refresh();
    return true;
  }

  const decide = (id: string, action: string, extra: object = {}) =>
    call(`${base}/${id}/decision`, { action, ...extra });

  async function bulk(action: 'approve' | 'reject') {
    const ids = [...selected];
    if (ids.length === 0) return;
    const reason = action === 'reject' ? window.prompt('Shared rejection reason:') : undefined;
    if (action === 'reject' && !reason) return;
    if (!window.confirm(`${action === 'approve' ? 'Approve' : 'Reject'} ${ids.length} item(s)?`))
      return;
    if (await call(`${base}/bulk`, { item_ids: ids, action, reason })) setSelected(new Set());
  }

  async function publishSelectedTo(tool: 'jira' | 'ado' | 'github', label: string) {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Publish ${ids.length} item(s) to ${label}?`)) return;
    setBusy(true);
    setError(null);
    const res = await fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/publish/${tool}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_ids: ids }),
      },
    );
    setBusy(false);
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
      succeeded?: number;
      failed?: number;
      results?: Array<{ ok: boolean; error?: string }>;
    };
    if (!res.ok) {
      setError(payload.detail ?? payload.error ?? 'Publishing failed.');
    } else if ((payload.failed ?? 0) > 0) {
      const firstError = payload.results?.find((r) => !r.ok)?.error;
      setError(`${payload.succeeded} published, ${payload.failed} failed — ${firstError ?? ''}`);
    }
    setSelected(new Set());
    router.refresh();
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filterLink = (key: string, value: string | null) => {
    const params = new URLSearchParams(
      Object.entries(activeFilters).filter(([, v]) => v) as [string, string][],
    );
    if (value === null) params.delete(key);
    else params.set(key, value);
    const qs = params.toString();
    return qs ? `${pageBase}?${qs}` : pageBase;
  };

  const titleById = new Map(items.map((i) => [i.id, i.title]));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <Link
          href={filterLink('flagged', activeFilters.flagged === '1' ? null : '1')}
          className={`rounded border px-2 py-1 ${activeFilters.flagged === '1' ? 'border-cobalt text-cobalt' : 'border-line text-sub'}`}
        >
          Flagged only
        </Link>
        <Link
          href={filterLink('sort', activeFilters.sort === 'score' ? null : 'score')}
          className={`rounded border px-2 py-1 ${activeFilters.sort === 'score' ? 'border-cobalt text-cobalt' : 'border-line text-sub'}`}
        >
          Weakest first
        </Link>
        {['EPIC', 'STORY', 'TASK', 'RISK', 'QUESTION'].map((t) => (
          <Link
            key={t}
            href={filterLink('type', activeFilters.type === t ? null : t)}
            className={`rounded border px-2 py-1 font-mono ${activeFilters.type === t ? 'border-cobalt text-cobalt' : 'border-line text-sub'}`}
          >
            {t}
          </Link>
        ))}
        {canReview && selected.size > 0 ? (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-sub">{selected.size} selected</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void bulk('approve')}
              className="rounded border border-line px-2 py-1 text-green"
            >
              Bulk approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void bulk('reject')}
              className="rounded border border-line px-2 py-1 text-red"
            >
              Bulk reject
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void publishSelectedTo('jira', 'Jira')}
              className="rounded border border-cobalt px-2 py-1 font-semibold text-cobalt"
            >
              Publish to Jira
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void publishSelectedTo('ado', 'Azure DevOps')}
              className="rounded border border-cobalt px-2 py-1 font-semibold text-cobalt"
            >
              Publish to ADO
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void publishSelectedTo('github', 'GitHub')}
              className="rounded border border-cobalt px-2 py-1 font-semibold text-cobalt"
            >
              Publish to GitHub
            </button>
          </span>
        ) : null}
      </div>

      {error ? <p className="mb-3 text-sm text-red">{error}</p> : null}
      {items.length === 0 ? <p className="text-sm text-sub">No items match this filter.</p> : null}

      <ul className="space-y-2">
        {items.map((item) => {
          const open = openId === item.id;
          return (
            <li key={item.id} className="rounded-md border border-line bg-panel">
              <div className="flex items-center gap-3 px-4 py-3">
                {canReview ? (
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                ) : null}
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setOpenId(open ? null : item.id);
                    setEditDraft(null);
                    setShowDiff(false);
                    setGapAnswer('');
                  }}
                >
                  <span className="mr-2 rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] font-bold text-sub">
                    {item.type}
                  </span>
                  <span className="text-sm font-semibold text-ink">{item.title}</span>
                  {item.parentId ? (
                    <span className="ml-2 text-xs text-sub">
                      ↳ {titleById.get(item.parentId) ?? 'parent'}
                    </span>
                  ) : null}
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {item.flags?.duplicate ? (
                    <span className="rounded bg-red-soft px-1.5 py-0.5 text-[10px] font-bold text-red">
                      possible duplicate · {item.flags.duplicate.key}
                    </span>
                  ) : null}
                  {item.flags?.gap ? (
                    <span className="rounded bg-red-soft px-1.5 py-0.5 text-[10px] font-bold text-red">
                      missing info
                    </span>
                  ) : null}
                  <ScoreBar score={item.qualityScore} />
                  <span
                    className={`font-mono text-[10px] font-bold ${STATUS_STYLES[item.status] ?? 'text-sub'}`}
                  >
                    {item.status}
                    {item.signedOff ? ' ✓✓' : ''}
                  </span>
                </div>
              </div>

              {open ? (
                <div className="border-t border-line px-4 py-4 text-sm">
                  {editDraft ? (
                    <div className="space-y-2">
                      <input
                        value={editDraft.title}
                        onChange={(e) => setEditDraft({ ...editDraft, title: e.target.value })}
                        className="w-full rounded border border-line bg-paper px-3 py-2 text-ink"
                      />
                      <textarea
                        value={editDraft.description}
                        rows={4}
                        onChange={(e) =>
                          setEditDraft({ ...editDraft, description: e.target.value })
                        }
                        className="w-full rounded border border-line bg-paper px-3 py-2 text-ink"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void decide(item.id, 'edit', { edits: editDraft }).then(
                              (ok) => ok && setEditDraft(null),
                            )
                          }
                          className="rounded bg-cobalt px-3 py-1.5 text-xs font-semibold text-white"
                        >
                          Save edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditDraft(null)}
                          className="rounded border border-line px-3 py-1.5 text-xs text-sub"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-ink">{item.description}</p>
                  )}

                  {item.deltaContext ? (
                    <div className="mt-3 rounded border border-cobalt/40 bg-cobalt-soft p-3 text-xs">
                      <p className="font-mono font-bold text-cobalt">
                        {item.deltaContext.reason === 'new'
                          ? 'NEW — FROM UPDATED SOURCE'
                          : item.deltaContext.reason === 'removed'
                            ? 'SOURCE CONTENT REMOVED'
                            : 'REVISED — SOURCE CHANGED'}
                      </p>
                      <p className="mt-1 text-sub">
                        {item.deltaContext.sourceName}: “{item.deltaContext.changedFragmentText}”
                      </p>
                      {item.deltaContext.previousVersion ? (
                        <div className="mt-2 border-t border-line pt-2">
                          <p className="font-mono text-[10px] font-bold text-sub">
                            PREVIOUS VERSION
                          </p>
                          <p className="mt-1 text-ink">{item.deltaContext.previousVersion.title}</p>
                          <p className="mt-1 text-sub">
                            {item.deltaContext.previousVersion.description}
                          </p>
                        </div>
                      ) : null}
                      {item.deltaContext.reason === 'removed' && item.publishedKey ? (
                        <button
                          type="button"
                          disabled={busy || flaggedIds.has(item.id)}
                          onClick={() => void flagRemoved(item.id)}
                          className="mt-2 rounded border border-cobalt px-2 py-1 font-mono text-[10px] font-semibold text-cobalt disabled:opacity-50"
                        >
                          {flaggedIds.has(item.id)
                            ? 'Flagged on ' + item.publishedKey + ' ✓'
                            : `Flag ${item.publishedKey} for reviewer (comment, never auto-close)`}
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {showDiff && item.originalDraft ? (
                    <div className="mt-3 rounded border border-line bg-paper p-3 text-xs">
                      <p className="font-mono font-bold text-sub">AI DRAFT</p>
                      <p className="mt-1 text-ink">{item.originalDraft.title}</p>
                      <p className="mt-1 text-sub">{item.originalDraft.description}</p>
                      {item.editHistory.length > 0 ? (
                        <p className="mt-2 text-sub">
                          {item.editHistory.length} edit(s) recorded since draft.
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {item.scoreDetail ? (
                    <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                      {(['completeness', 'clarity', 'testability', 'specificity'] as const).map(
                        (k) => (
                          <div key={k} className="rounded border border-line bg-paper px-2 py-1.5">
                            <span className="block text-sub">{k}</span>
                            <span className="font-mono font-bold text-ink">
                              {item.scoreDetail?.[k] ?? '—'}
                            </span>
                          </div>
                        ),
                      )}
                      {item.scoreDetail.rationale ? (
                        <p className="col-span-4 text-sub">{item.scoreDetail.rationale}</p>
                      ) : null}
                    </div>
                  ) : null}

                  {item.sources.length > 0 ? (
                    <div className="mt-3 space-y-1">
                      {item.sources.map((s, i) => (
                        <div
                          key={i}
                          className="rounded border border-line bg-paper px-3 py-2 text-xs"
                        >
                          <span className="font-mono font-bold text-sub">{s.label}</span>
                          <p className="mt-1 text-ink">{s.text}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-red">
                      ⚠ No traceable source recorded for this item.
                    </p>
                  )}

                  {item.flags?.publishError ? (
                    <p className="mt-3 text-xs text-red">
                      Publish failed: {item.flags.publishError}
                    </p>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => setTraceItemId(traceItemId === item.id ? null : item.id)}
                    className="mt-3 text-xs text-cobalt underline-offset-2 hover:underline"
                  >
                    {traceItemId === item.id ? 'Hide full trace' : 'View full trace'}
                  </button>
                  {traceItemId === item.id ? (
                    <TracePanel workspaceId={workspaceId} itemId={item.id} />
                  ) : null}

                  {item.flags?.duplicate && item.duplicateReference && canReview ? (
                    <div className="mt-3 rounded border border-line bg-paper p-3 text-xs">
                      <p className="font-mono font-bold text-sub">
                        POSSIBLE DUPLICATE · {item.flags.duplicate.tool} {item.flags.duplicate.key}{' '}
                        · {Math.round(item.flags.duplicate.confidence * 100)}% match
                      </p>
                      <div className="mt-2 grid grid-cols-2 gap-3">
                        <div>
                          <p className="font-bold text-ink">Generated</p>
                          <p className="text-ink">{item.title}</p>
                          <p className="text-sub">{item.description}</p>
                        </div>
                        <div>
                          <p className="font-bold text-ink">
                            Existing ({item.duplicateReference.state})
                          </p>
                          <p className="text-ink">{item.duplicateReference.title}</p>
                          <p className="text-sub">{item.duplicateReference.description}</p>
                        </div>
                      </div>
                      <div className="mt-2 flex gap-2">
                        {(['confirm', 'merge', 'override'] as const).map((r) => (
                          <button
                            key={r}
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void call(`${base}/${item.id}/resolve-duplicate`, { resolution: r })
                            }
                            className="rounded border border-line px-2 py-1 text-xs text-ink hover:bg-panel"
                          >
                            {r === 'confirm'
                              ? 'Confirm duplicate'
                              : r === 'merge'
                                ? 'Merge into existing'
                                : 'Not a duplicate'}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {item.flags?.gap && canReview ? (
                    <div className="mt-3 rounded border border-line bg-paper p-3 text-xs">
                      <p className="font-mono font-bold text-red">MISSING INFORMATION</p>
                      <p className="mt-1 text-ink">{item.flags.gap.question}</p>
                      <textarea
                        value={gapAnswer}
                        rows={2}
                        placeholder="Answer the question to regenerate…"
                        onChange={(e) => setGapAnswer(e.target.value)}
                        className="mt-2 w-full rounded border border-line bg-panel px-3 py-2 text-ink"
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={busy || !gapAnswer.trim()}
                          onClick={() =>
                            void call(`${base}/${item.id}/resolve-gap`, {
                              resolution: 'regenerate',
                              answer: gapAnswer,
                            })
                          }
                          className="rounded bg-cobalt px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Add context & regenerate
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void call(`${base}/${item.id}/resolve-gap`, { resolution: 'manual' })
                          }
                          className="rounded border border-line px-2 py-1 text-xs text-ink"
                        >
                          Mark manually resolved
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {canReview ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {item.status !== 'APPROVED' ? (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void decide(item.id, 'approve')}
                            className="rounded bg-cobalt px-3 py-1.5 text-xs font-semibold text-white"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              const reason = window.prompt('Rejection reason (required):');
                              if (reason) void decide(item.id, 'reject', { reason });
                            }}
                            className="rounded border border-line px-3 py-1.5 text-xs text-red"
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setEditDraft({ title: item.title, description: item.description })
                            }
                            className="rounded border border-line px-3 py-1.5 text-xs text-ink"
                          >
                            Edit
                          </button>
                        </>
                      ) : (
                        <>
                          {approvalStages === 2 && !item.signedOff && isAdmin ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void decide(item.id, 'signoff')}
                              className="rounded bg-cobalt px-3 py-1.5 text-xs font-semibold text-white"
                            >
                              Sign off
                            </button>
                          ) : null}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void decide(item.id, 'reopen')}
                            className="rounded border border-line px-3 py-1.5 text-xs text-sub"
                          >
                            Reopen
                          </button>
                        </>
                      )}
                      {item.originalDraft ? (
                        <button
                          type="button"
                          onClick={() => setShowDiff(!showDiff)}
                          className="rounded border border-line px-3 py-1.5 text-xs text-sub"
                        >
                          {showDiff ? 'Hide AI draft' : 'Show AI draft'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
