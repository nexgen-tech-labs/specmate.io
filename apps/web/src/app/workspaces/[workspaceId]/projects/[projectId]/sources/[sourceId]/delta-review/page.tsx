import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireProjectRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { ReviewQueue, type ReviewItem } from '@/components/review/review-queue';

// Delta review queue (Issue 9.3): only the items a targeted regeneration run
// (Issue 9.2) touched for this specific source version — new/revised/flagged-removed
// — never the whole project backlog. Reuses ReviewQueue (Epic 4) as-is for the
// actual approve/reject/edit mechanism; this page's job is scoping + "what changed."
export default async function DeltaReviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string; sourceId: string }>;
}) {
  const { workspaceId, projectId, sourceId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) notFound();

  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    include: { workspace: { select: { approvalStages: true } } },
  });
  if (!project) notFound();

  const source = await prisma.source.findFirst({
    where: { id: sourceId, projectId, deletedAt: null },
  });
  if (!source) notFound();

  const diff = await prisma.sourceDiff.findUnique({ where: { sourceId } });

  const items = await prisma.draftItem.findMany({
    where: { projectId, sourceVersionId: sourceId },
    include: {
      publishedItems: { where: { deletedAt: null }, take: 1 },
      traceLinks: {
        include: {
          rawRequirement: { select: { text: true, sectionPath: true } },
          source: { select: { name: true, kind: true } },
        },
      },
    },
    orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
  });

  // Previous-version titles/descriptions for the side-by-side (revisionOfId chain),
  // and the changed fragment text each item is tied to (via SourceDiff's own record,
  // keyed by the item's current sourceId+fragment on its TraceLink).
  const revisionOfIds = items.map((i) => i.revisionOfId).filter((id): id is string => !!id);
  const previousItems = revisionOfIds.length
    ? await prisma.draftItem.findMany({
        where: { id: { in: revisionOfIds } },
        select: { id: true, title: true, description: true },
      })
    : [];
  const previousById = new Map(previousItems.map((p) => [p.id, p]));

  const fragmentsByRawId = new Map(
    (
      (diff?.fragments as Array<{ rawRequirementId: string | null; sectionPath: string }>) ?? []
    ).map((f) => [f.rawRequirementId, f]),
  );

  const rows: ReviewItem[] = items.map((item) => {
    const flags = item.flags as ReviewItem['flags'];
    const sourceFlags = item.flags as { sourceRemoved?: boolean; sourceModified?: boolean } | null;
    const reason: 'new' | 'modified' | 'removed' = sourceFlags?.sourceRemoved
      ? 'removed'
      : item.revisionOfId || sourceFlags?.sourceModified
        ? 'modified'
        : 'new';
    const trace = item.traceLinks[0];
    const changedFragment = trace ? fragmentsByRawId.get(trace.rawRequirementId) : undefined;
    const previous = item.revisionOfId ? (previousById.get(item.revisionOfId) ?? null) : null;

    return {
      id: item.id,
      type: item.type,
      title: item.title,
      description: item.description,
      status: item.status,
      qualityScore: item.qualityScore,
      scoreDetail: item.scoreDetail as ReviewItem['scoreDetail'],
      flags,
      parentId: item.parentId,
      signedOff: item.signedOffByUserId !== null,
      originalDraft: item.originalDraft as ReviewItem['originalDraft'],
      editHistory: (item.editHistory as ReviewItem['editHistory']) ?? [],
      publishedKey: item.publishedItems[0]?.externalKey ?? null,
      publishedUrl: item.publishedItems[0]?.externalUrl ?? null,
      sources: item.traceLinks.map((t) => ({
        label: `${t.source.name} · ${t.rawRequirement.sectionPath}`,
        text: t.rawRequirement.text,
      })),
      duplicateReference: null,
      deltaContext: {
        reason,
        sourceName: source.name,
        changedFragmentText:
          trace?.rawRequirement.text ?? changedFragment?.sectionPath ?? '(source content removed)',
        previousVersion: previous,
      },
    };
  });

  const canReview = access.membership.role !== 'VIEWER';
  const isAdmin = access.membership.role === 'ADMIN';

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-ink">
              What changed — {source.name}
            </h1>
            <p className="mt-2 text-base text-sub">
              {diff
                ? `${diff.addedCount} new · ${diff.modifiedCount} revised · ${diff.removedCount} removed · ${diff.unchangedCount} unchanged (not shown)`
                : `${rows.length} item(s) affected by this source update`}
              {' — the rest of the backlog is untouched.'}
            </p>
          </div>
          <Link
            href={`/workspaces/${workspaceId}/projects/${projectId}/review`}
            className="text-sm text-cobalt underline-offset-2 hover:underline"
          >
            Full review queue →
          </Link>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-md border border-line bg-panel p-6 text-sm text-sub">
            No delta items yet — run targeted regeneration for this source version first.
          </p>
        ) : (
          <ReviewQueue
            workspaceId={workspaceId}
            projectId={projectId}
            items={rows}
            canReview={canReview}
            isAdmin={isAdmin}
            approvalStages={project.workspace.approvalStages}
            activeFilters={{}}
          />
        )}
      </div>
    </div>
  );
}
