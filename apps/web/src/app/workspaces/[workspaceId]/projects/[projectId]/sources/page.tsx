import { notFound } from 'next/navigation';
import { requireProjectRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { UploadZone } from '@/components/sources/upload-zone';
import { SourceList, type SourceRow } from '@/components/sources/source-list';

export default async function ProjectSourcesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) notFound();

  const project = access.project;

  const [sources, referenceItems] = await Promise.all([
    prisma.source.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { rawRequirements: { where: { deletedAt: null } } } } },
    }),
    prisma.referenceItem.findMany({
      where: { projectId },
      orderBy: [{ tool: 'asc' }, { externalKey: 'asc' }],
    }),
  ]);

  const versionedSourceIds = sources.filter((s) => s.previousVersionId).map((s) => s.id);
  const diffSourceIds = versionedSourceIds.length
    ? new Set(
        (
          await prisma.sourceDiff.findMany({
            where: { sourceId: { in: versionedSourceIds } },
            select: { sourceId: true },
          })
        ).map((d) => d.sourceId),
      )
    : new Set<string>();

  const rows: SourceRow[] = sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    status: source.status,
    parseError: source.parseError,
    fragmentCount: source._count.rawRequirements,
    updatedAt: source.updatedAt.toISOString(),
    isNewVersion: source.previousVersionId !== null,
    hasDiff: diffSourceIds.has(source.id),
  }));

  const fragmentTotal = rows.reduce((sum, row) => sum + row.fragmentCount, 0);
  const lastUpdated = sources.length
    ? new Date(Math.max(...sources.map((s) => s.updatedAt.getTime())))
    : null;

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight text-ink">Sources</h1>
          <p className="mt-2 text-base text-sub">Upload requirement documents for {project.name}</p>
        </div>

        <div className="mb-6 flex gap-6 rounded-md border border-line bg-panel px-4 py-3 font-mono text-xs text-sub">
          <span>
            <span className="font-bold text-ink">{rows.length}</span> source
            {rows.length === 1 ? '' : 's'}
          </span>
          <span>
            <span className="font-bold text-ink">{fragmentTotal}</span> fragment
            {fragmentTotal === 1 ? '' : 's'} extracted
          </span>
          {lastUpdated ? <span>last updated {lastUpdated.toLocaleString()}</span> : null}
        </div>

        <UploadZone workspaceId={workspaceId} projectId={projectId} />
        <SourceList workspaceId={workspaceId} projectId={projectId} sources={rows} />

        {referenceItems.length > 0 ? (
          <div className="mt-10">
            <h2 className="text-lg font-bold text-ink">Reference backlog items</h2>
            <p className="mt-1 text-sm text-sub">
              Pulled from connected tools for duplicate detection — read-only, never edited or
              published by SpecMate.
            </p>
            <ul className="mt-3 space-y-2">
              {referenceItems.map((item) => (
                <li
                  key={item.id}
                  className="rounded-md border border-line bg-panel px-4 py-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 text-ink">
                      <span className="font-mono text-xs text-sub">
                        {item.tool} {item.externalKey}
                      </span>{' '}
                      {item.title}
                    </span>
                    <span className="shrink-0 rounded bg-paper px-2 py-0.5 font-mono text-xs font-bold tracking-wide text-sub">
                      READ-ONLY
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
