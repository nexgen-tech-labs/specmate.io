import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { ActivityPoller } from '@/components/review/activity-poller';

export default async function ReviewActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{ actor?: string; action?: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const filters = await searchParams;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) notFound();

  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) notFound();

  // The feed reads straight from AuditEvent (Epic 8's log) — no separate feed store,
  // so it can't drift from the audit trail (Issue 4.8 AC).
  const itemIds = (
    await prisma.draftItem.findMany({ where: { projectId }, select: { id: true } })
  ).map((i) => i.id);

  const events = await prisma.auditEvent.findMany({
    where: {
      workspaceId,
      entityType: 'DraftItem',
      entityId: { in: itemIds },
      ...(filters.action ? { action: { contains: filters.action } } : {}),
      ...(filters.actor ? { actor: { email: { contains: filters.actor } } } : {}),
    },
    include: { actor: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  const itemTitles = new Map(
    (
      await prisma.draftItem.findMany({
        where: { id: { in: events.map((e) => e.entityId) } },
        select: { id: true, title: true },
      })
    ).map((i) => [i.id, i.title]),
  );

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <Link
            href={`/workspaces/${workspaceId}/projects/${projectId}/review`}
            className="text-sm text-cobalt underline-offset-2 hover:underline"
          >
            ← Back to review
          </Link>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">Review activity</h1>
          <p className="mt-2 text-base text-sub">
            Every review action across {project.name}, straight from the audit log.
          </p>
        </div>

        <ActivityPoller intervalMs={5000} />

        {events.length === 0 ? (
          <p className="text-sm text-sub">No review activity yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex items-baseline gap-3 rounded-md border border-line bg-panel px-4 py-2.5 text-sm"
              >
                <span className="shrink-0 font-mono text-xs text-sub">
                  {event.createdAt.toLocaleTimeString()}
                </span>
                <span className="shrink-0 rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] font-bold text-sub">
                  {event.action}
                </span>
                <span className="min-w-0 truncate text-ink">
                  {itemTitles.get(event.entityId) ?? event.entityId}
                </span>
                <span className="ml-auto shrink-0 text-xs text-sub">
                  {event.actor?.name ?? 'system'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
