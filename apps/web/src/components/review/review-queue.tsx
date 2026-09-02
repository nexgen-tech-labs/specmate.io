'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ReviewRunGroup } from '@/components/review/review-run-group';

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
  // Which GenerationRun produced this item — drives the review queue's
  // collapsible per-run grouping. Null for items predating this field.
  generationRunId: string | null;
  // Issue 9.3: present only in the delta review queue — what changed in the source
  // and (for revised items) the previous item's title/description side-by-side.
  deltaContext?: {
    reason: 'new' | 'modified' | 'removed';
    sourceName: string;
    changedFragmentText: string;
    previousVersion: { title: string; description: string } | null;
  } | null;
}

export interface RunGroup {
  id: string;
  name: string | null;
  tag: string | null;
  stage: string;
  createdAt: string;
}

export function ReviewQueue({
  workspaceId,
  projectId,
  items,
  canReview,
  isAdmin,
  approvalStages,
  activeFilters,
  totalItemCount,
  sourceCount,
  latestRunId,
  latestRunStage,
  runs,
}: {
  workspaceId: string;
  projectId: string;
  items: ReviewItem[];
  canReview: boolean;
  isAdmin: boolean;
  approvalStages: number;
  activeFilters: { type?: string; status?: string; flagged?: string; sort?: string };
  totalItemCount: number;
  sourceCount: number;
  /** Staged generation (Onboarding Flow redesign follow-up): while the
   * latest run is EPICS_PENDING_REVIEW, `items` contains only epics — show a
   * banner + "Generate stories & tasks" button instead of treating this like
   * a normal fully-generated queue. Null once COMPLETE, or if no run exists
   * yet (today's existing empty state below is unchanged in that case). */
  latestRunId: string | null;
  latestRunStage: string | null;
  /** Every run for this project (not just the latest) — powers the
   * collapsible per-run grouping below. Empty/missing runs fall back to an
   * "Ungrouped" bucket (legacy items predating generationRunId). */
  runs: RunGroup[];
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
  const [generatingDownstream, setGeneratingDownstream] = useState(false);
  const [downstreamError, setDownstreamError] = useState<string | null>(null);

  const isPendingEpicReview = latestRunStage === 'EPICS_PENDING_REVIEW';
  const approvedEpicCount = items.filter(
    (i) => i.type === 'EPIC' && i.status === 'APPROVED',
  ).length;

  async function generateDownstream(): Promise<void> {
    if (!latestRunId) return;
    setGeneratingDownstream(true);
    setDownstreamError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/generation-runs/${latestRunId}/generate-downstream`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        setDownstreamError(body.detail ?? body.error ?? 'Generation failed — try again.');
        return;
      }
      router.refresh();
    } catch {
      setDownstreamError('Could not reach the generation service — try again.');
    } finally {
      setGeneratingDownstream(false);
    }
  }

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

  function toggleGroup(ids: string[]) {
    setSelected((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const allSelected = items.length > 0 && items.every((i) => prev.has(i.id));
      return allSelected ? new Set() : new Set(items.map((i) => i.id));
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
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs" data-tour="review-toolbar">
        {canReview && items.length > 0 ? (
          <label className="flex items-center gap-1.5 rounded border border-line px-2 py-1 text-sub">
            <input
              type="checkbox"
              checked={items.length > 0 && items.every((i) => selected.has(i.id))}
              onChange={toggleSelectAll}
            />
            Select all
          </label>
        ) : null}
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
        {['PENDING', 'APPROVED', 'REJECTED'].map((s) => (
          <Link
            key={s}
            href={filterLink('status', activeFilters.status === s ? null : s)}
            className={`rounded border px-2 py-1 font-mono ${activeFilters.status === s ? 'border-cobalt text-cobalt' : 'border-line text-sub'}`}
          >
            {s}
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

      {isPendingEpicReview ? (
        <div className="mb-4 rounded-md border border-cobalt bg-panel px-4 py-3 text-sm">
          <p className="font-semibold text-ink">
            {items.length} epic{items.length === 1 ? '' : 's'} generated. Approve the ones you want,
            then generate their stories and tasks.
          </p>
          {downstreamError ? <p className="mt-1 text-sm text-red">{downstreamError}</p> : null}
          {canReview ? (
            <button
              type="button"
              disabled={approvedEpicCount === 0 || generatingDownstream}
              onClick={() => void generateDownstream()}
              className="mt-2 rounded bg-cobalt px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {generatingDownstream ? 'Generating…' : 'Generate stories & tasks'}
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="mb-3 text-sm text-red">{error}</p> : null}
      {items.length === 0 ? (
        totalItemCount === 0 ? (
          <div className="rounded-md border border-line bg-panel px-4 py-6 text-sm">
            <p className="font-semibold text-ink">
              {sourceCount === 0 ? 'This project has no sources yet.' : 'No items generated yet.'}
            </p>
            <p className="mt-1 text-sub">
              {sourceCount === 0
                ? 'Upload a source document and run generation to see items here.'
                : 'Sources are uploaded — run generation to produce items for review.'}
            </p>
            <Link
              href={`/workspaces/${workspaceId}/projects/${projectId}/get-started`}
              className="mt-3 inline-block rounded bg-cobalt px-3 py-1.5 text-xs font-semibold text-white"
            >
              Get started →
            </Link>
          </div>
        ) : (
          <p className="text-sm text-sub">No items match this filter.</p>
        )
      ) : null}

      {(() => {
        const byRun = new Map<string, ReviewItem[]>();
        for (const item of items) {
          const key = item.generationRunId ?? '__ungrouped__';
          const bucket = byRun.get(key);
          if (bucket) bucket.push(item);
          else byRun.set(key, [item]);
        }
        const orderedRuns: RunGroup[] = [
          ...runs,
          ...(byRun.has('__ungrouped__')
            ? [
                {
                  id: '__ungrouped__',
                  name: 'Ungrouped',
                  tag: null,
                  stage: 'COMPLETE',
                  createdAt: '',
                },
              ]
            : []),
        ];
        return orderedRuns
          .filter((run) => byRun.has(run.id))
          .map((run) => (
            <ReviewRunGroup
              key={run.id}
              run={run}
              items={byRun.get(run.id) ?? []}
              workspaceId={workspaceId}
              projectId={projectId}
              base={base}
              canReview={canReview}
              isAdmin={isAdmin}
              approvalStages={approvalStages}
              selected={selected}
              openId={openId}
              editDraft={editDraft}
              gapAnswer={gapAnswer}
              showDiff={showDiff}
              traceItemId={traceItemId}
              busy={busy}
              flaggedIds={flaggedIds}
              titleById={titleById}
              onToggleSelected={toggle}
              onToggleGroup={toggleGroup}
              onToggleOpen={(id) => setOpenId(openId === id ? null : id)}
              setEditDraft={setEditDraft}
              setGapAnswer={setGapAnswer}
              setShowDiff={setShowDiff}
              setTraceItemId={setTraceItemId}
              decide={decide}
              call={call}
              flagRemoved={flagRemoved}
            />
          ));
      })()}
    </div>
  );
}
