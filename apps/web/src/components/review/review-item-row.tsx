'use client';

import { TracePanel } from '@/components/review/trace-panel';
import type { ReviewItem } from '@/components/review/review-queue';

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

// Extracted verbatim from review-queue.tsx's former single flat item list
// (Onboarding Flow redesign follow-up: grouping the queue by GenerationRun) —
// all per-item state (open/edit/gap-answer/etc.) stays lifted in ReviewQueue
// since it's keyed by item id and doesn't need to be group-aware.
export function ReviewItemRow({
  item,
  workspaceId,
  base,
  canReview,
  isAdmin,
  approvalStages,
  selected,
  open,
  editDraft,
  gapAnswer,
  showDiff,
  traceItemId,
  busy,
  flaggedIds,
  titleById,
  onToggleSelected,
  onToggleOpen,
  setEditDraft,
  setGapAnswer,
  setShowDiff,
  setTraceItemId,
  decide,
  call,
  flagRemoved,
}: {
  item: ReviewItem;
  workspaceId: string;
  base: string;
  canReview: boolean;
  isAdmin: boolean;
  approvalStages: number;
  selected: boolean;
  open: boolean;
  editDraft: { title: string; description: string } | null;
  gapAnswer: string;
  showDiff: boolean;
  traceItemId: string | null;
  busy: boolean;
  flaggedIds: Set<string>;
  titleById: Map<string, string>;
  onToggleSelected: (id: string) => void;
  onToggleOpen: (id: string) => void;
  setEditDraft: (draft: { title: string; description: string } | null) => void;
  setGapAnswer: (value: string) => void;
  setShowDiff: (value: boolean) => void;
  setTraceItemId: (id: string | null) => void;
  decide: (id: string, action: string, extra?: object) => Promise<boolean>;
  call: (url: string, body: unknown) => Promise<boolean>;
  flagRemoved: (id: string) => Promise<void>;
}) {
  return (
    <li className="rounded-md border border-line bg-panel">
      <div className="flex items-center gap-3 px-4 py-3">
        {canReview ? (
          <input type="checkbox" checked={selected} onChange={() => onToggleSelected(item.id)} />
        ) : null}
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => {
            onToggleOpen(item.id);
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
                onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
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
                  <p className="font-mono text-[10px] font-bold text-sub">PREVIOUS VERSION</p>
                  <p className="mt-1 text-ink">{item.deltaContext.previousVersion.title}</p>
                  <p className="mt-1 text-sub">{item.deltaContext.previousVersion.description}</p>
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
              {(['completeness', 'clarity', 'testability', 'specificity'] as const).map((k) => (
                <div key={k} className="rounded border border-line bg-paper px-2 py-1.5">
                  <span className="block text-sub">{k}</span>
                  <span className="font-mono font-bold text-ink">
                    {item.scoreDetail?.[k] ?? '—'}
                  </span>
                </div>
              ))}
              {item.scoreDetail.rationale ? (
                <p className="col-span-4 text-sub">{item.scoreDetail.rationale}</p>
              ) : null}
            </div>
          ) : null}

          {item.sources.length > 0 ? (
            <div className="mt-3 space-y-1">
              {item.sources.map((s, i) => (
                <div key={i} className="rounded border border-line bg-paper px-3 py-2 text-xs">
                  <span className="font-mono font-bold text-sub">{s.label}</span>
                  <p className="mt-1 text-ink">{s.text}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-red">⚠ No traceable source recorded for this item.</p>
          )}

          {item.flags?.publishError ? (
            <p className="mt-3 text-xs text-red">Publish failed: {item.flags.publishError}</p>
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
                POSSIBLE DUPLICATE · {item.flags.duplicate.tool} {item.flags.duplicate.key} ·{' '}
                {Math.round(item.flags.duplicate.confidence * 100)}% match
              </p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <p className="font-bold text-ink">Generated</p>
                  <p className="text-ink">{item.title}</p>
                  <p className="text-sub">{item.description}</p>
                </div>
                <div>
                  <p className="font-bold text-ink">Existing ({item.duplicateReference.state})</p>
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
}
