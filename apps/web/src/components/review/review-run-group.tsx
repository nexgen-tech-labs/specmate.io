'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ReviewItemRow } from '@/components/review/review-item-row';
import type { ReviewItem, RunGroup } from '@/components/review/review-queue';

// First collapsible/accordion pattern in apps/web (Onboarding Flow redesign
// follow-up: grouping the review queue by GenerationRun) — a native <details>
// rather than a new library, per this codebase's minimal-dependency stance.
export function ReviewRunGroup({
  run,
  items,
  workspaceId,
  projectId,
  base,
  canReview,
  isAdmin,
  approvalStages,
  selected,
  openId,
  editDraft,
  gapAnswer,
  showDiff,
  traceItemId,
  busy,
  flaggedIds,
  titleById,
  onToggleSelected,
  onToggleGroup,
  onToggleOpen,
  setEditDraft,
  setGapAnswer,
  setShowDiff,
  setTraceItemId,
  decide,
  call,
  flagRemoved,
}: {
  run: RunGroup;
  items: ReviewItem[];
  workspaceId: string;
  projectId: string;
  base: string;
  canReview: boolean;
  isAdmin: boolean;
  approvalStages: number;
  selected: Set<string>;
  openId: string | null;
  editDraft: { title: string; description: string } | null;
  gapAnswer: string;
  showDiff: boolean;
  traceItemId: string | null;
  busy: boolean;
  flaggedIds: Set<string>;
  titleById: Map<string, string>;
  onToggleSelected: (id: string) => void;
  onToggleGroup: (ids: string[]) => void;
  onToggleOpen: (id: string) => void;
  setEditDraft: (draft: { title: string; description: string } | null) => void;
  setGapAnswer: (value: string) => void;
  setShowDiff: (value: boolean) => void;
  setTraceItemId: (id: string | null) => void;
  decide: (id: string, action: string, extra?: object) => Promise<boolean>;
  call: (url: string, body: unknown) => Promise<boolean>;
  flagRemoved: (id: string) => Promise<void>;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(run.name ?? '');
  const [renameError, setRenameError] = useState<string | null>(null);

  const itemIds = items.map((i) => i.id);
  const allSelected = itemIds.length > 0 && itemIds.every((id) => selected.has(id));

  async function saveRename(): Promise<void> {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setRenameError('Name cannot be empty.');
      return;
    }
    setRenameError(null);
    const res = await fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/generation-runs/${run.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      setRenameError(body.detail ?? body.error ?? 'Could not rename this run.');
      return;
    }
    setRenaming(false);
    router.refresh();
  }

  return (
    <details open className="mb-3 rounded-md border border-line" data-tour="review-run-group">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          {canReview ? (
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => onToggleGroup(itemIds)}
              onClick={(e) => e.stopPropagation()}
            />
          ) : null}
          {renaming ? (
            <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveRename();
                  if (e.key === 'Escape') {
                    setRenaming(false);
                    setNameDraft(run.name ?? '');
                    setRenameError(null);
                  }
                }}
                onBlur={() => void saveRename()}
                className="rounded border border-line bg-paper px-2 py-1 text-sm text-ink"
              />
            </span>
          ) : (
            <span
              className="truncate text-sm font-semibold text-ink"
              onClick={(e) => {
                if (!canReview) return;
                e.preventDefault();
                e.stopPropagation();
                setNameDraft(run.name ?? '');
                setRenaming(true);
              }}
              title={canReview ? 'Click to rename' : undefined}
            >
              {run.name ?? 'Untitled run'}
            </span>
          )}
          <span className="shrink-0 text-xs text-sub">({items.length} items)</span>
        </span>
      </summary>
      {renameError ? <p className="px-4 pb-2 text-xs text-red">{renameError}</p> : null}
      <ul className="space-y-2 px-2 pb-2" data-tour="review-item-list">
        {items.map((item) => (
          <ReviewItemRow
            key={item.id}
            item={item}
            workspaceId={workspaceId}
            base={base}
            canReview={canReview}
            isAdmin={isAdmin}
            approvalStages={approvalStages}
            selected={selected.has(item.id)}
            open={openId === item.id}
            editDraft={editDraft}
            gapAnswer={gapAnswer}
            showDiff={showDiff}
            traceItemId={traceItemId}
            busy={busy}
            flaggedIds={flaggedIds}
            titleById={titleById}
            onToggleSelected={onToggleSelected}
            onToggleOpen={onToggleOpen}
            setEditDraft={setEditDraft}
            setGapAnswer={setGapAnswer}
            setShowDiff={setShowDiff}
            setTraceItemId={setTraceItemId}
            decide={decide}
            call={call}
            flagRemoved={flagRemoved}
          />
        ))}
      </ul>
    </details>
  );
}
