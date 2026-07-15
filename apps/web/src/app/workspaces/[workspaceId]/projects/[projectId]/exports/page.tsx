import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireProjectRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { ProjectExports, type SnapshotRow } from '@/components/exports/project-exports';

// Exports (Issues 8.4/8.5): trace snapshots + approval reports.
export default async function ProjectExportsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) notFound();
  const project = access.project;

  // Read snapshots via Prisma directly (server component) — same rows the proxy serves.
  const snapshots = await prisma.snapshot.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, kind: true, createdAt: true, data: true },
  });
  const rows: SnapshotRow[] = snapshots.map((s) => {
    const counts = (s.data as { counts?: { items?: number; sources?: number } }).counts ?? {};
    return {
      id: s.id,
      kind: s.kind,
      created_at: s.createdAt.toISOString(),
      item_count: counts.items ?? 0,
      source_count: counts.sources ?? 0,
    };
  });

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-3xl">
        <Link
          href={`/workspaces/${workspaceId}/projects/${projectId}/review`}
          className="text-sm text-cobalt underline-offset-2 hover:underline"
        >
          ← Back to review
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">Exports</h1>
        <p className="mt-2 text-base text-sub">
          Compliance handoff and sign-off artifacts for {project.name}.
        </p>
        <ProjectExports
          workspaceId={workspaceId}
          projectId={projectId}
          snapshots={rows}
          canCreate={access.membership.role !== 'VIEWER'}
        />
      </div>
    </div>
  );
}
