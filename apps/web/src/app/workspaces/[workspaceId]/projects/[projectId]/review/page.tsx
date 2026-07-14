import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { ReviewQueue, type ReviewItem } from '@/components/review/review-queue';

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{ type?: string; status?: string; flagged?: string; sort?: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const filters = await searchParams;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) notFound();

  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    include: { workspace: { select: { approvalStages: true } } },
  });
  if (!project) notFound();

  const items = await prisma.draftItem.findMany({
    where: {
      projectId,
      deletedAt: null,
      ...(filters.type ? { type: filters.type as never } : {}),
      ...(filters.status ? { status: filters.status as never } : {}),
    },
    include: {
      publishedItems: { where: { deletedAt: null }, take: 1 },
      traceLinks: {
        include: {
          rawRequirement: { select: { text: true, sectionPath: true } },
          source: { select: { name: true, kind: true } },
        },
      },
    },
    orderBy:
      filters.sort === 'score'
        ? [{ qualityScore: 'asc' }, { createdAt: 'asc' }]
        : [{ type: 'asc' }, { createdAt: 'asc' }],
  });

  // Side-by-side data for duplicate resolution (Issue 4.5).
  const duplicateKeys = items
    .map((i) => (i.flags as { duplicate?: { key?: string } } | null)?.duplicate?.key)
    .filter((k): k is string => Boolean(k));
  const references = duplicateKeys.length
    ? await prisma.referenceItem.findMany({
        where: { projectId, externalKey: { in: duplicateKeys } },
      })
    : [];
  const referenceByKey = Object.fromEntries(
    references.map((r) => [
      r.externalKey,
      { title: r.title, description: r.description, state: r.state },
    ]),
  );

  let rows: ReviewItem[] = items.map((item) => ({
    id: item.id,
    type: item.type,
    title: item.title,
    description: item.description,
    status: item.status,
    qualityScore: item.qualityScore,
    scoreDetail: item.scoreDetail as ReviewItem['scoreDetail'],
    flags: item.flags as ReviewItem['flags'],
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
    duplicateReference:
      (item.flags as { duplicate?: { key?: string } } | null)?.duplicate?.key != null
        ? (referenceByKey[(item.flags as { duplicate: { key: string } }).duplicate.key] ?? null)
        : null,
  }));

  if (filters.flagged === '1') {
    rows = rows.filter((r) => r.flags && (r.flags.duplicate || r.flags.gap));
  }

  const canReview = access.membership.role !== 'VIEWER';
  const isAdmin = access.membership.role === 'ADMIN';

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-ink">Review</h1>
            <p className="mt-2 text-base text-sub">
              Generated items for {project.name} — approve, edit, or reject before publishing.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Link
              href={`/workspaces/${workspaceId}/projects/${projectId}/review/activity`}
              className="text-sm text-cobalt underline-offset-2 hover:underline"
            >
              Activity feed →
            </Link>
            <Link
              href={`/workspaces/${workspaceId}/projects/${projectId}/audit`}
              className="text-sm text-cobalt underline-offset-2 hover:underline"
            >
              Audit trail →
            </Link>
            <Link
              href={`/workspaces/${workspaceId}/projects/${projectId}/exports`}
              className="text-sm text-cobalt underline-offset-2 hover:underline"
            >
              Exports →
            </Link>
          </div>
        </div>
        <ReviewQueue
          workspaceId={workspaceId}
          projectId={projectId}
          items={rows}
          canReview={canReview}
          isAdmin={isAdmin}
          approvalStages={project.workspace.approvalStages}
          activeFilters={filters}
        />
      </div>
    </div>
  );
}
