import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { traceByExternalKey } from '@/lib/trace';
import type { Prisma } from '@prisma/client';

// Audit trail (Issue 8.3): timeline over the append-only AuditEvent log with
// project/actor/action/date filters, plus external-key trace search (Issue 8.2).
export default async function AuditTrailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{
    actor?: string;
    action?: string;
    from?: string;
    to?: string;
    key?: string;
  }>;
}) {
  const { workspaceId, projectId } = await params;
  const filters = await searchParams;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) notFound();
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) notFound();

  // Events with projectId (new writes) plus legacy project events written before the
  // projectId column existed (entityId ∈ this project's items).
  const itemIds = (
    await prisma.draftItem.findMany({ where: { projectId }, select: { id: true } })
  ).map((i) => i.id);
  const sourceIds = (
    await prisma.source.findMany({ where: { projectId }, select: { id: true } })
  ).map((s) => s.id);

  const where: Prisma.AuditEventWhereInput = {
    workspaceId,
    OR: [{ projectId }, { entityId: { in: [...itemIds, ...sourceIds] } }],
    ...(filters.action ? { action: { contains: filters.action } } : {}),
    ...(filters.actor ? { actor: { email: { contains: filters.actor } } } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: new Date(filters.from) } : {}),
            ...(filters.to ? { lte: new Date(`${filters.to}T23:59:59.999Z`) } : {}),
          },
        }
      : {}),
  };

  const events = await prisma.auditEvent.findMany({
    where,
    include: { actor: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const entityTitles = new Map(
    (
      await prisma.draftItem.findMany({
        where: { id: { in: events.map((e) => e.entityId) } },
        select: { id: true, title: true },
      })
    ).map((i) => [i.id, i.title]),
  );
  for (const s of await prisma.source.findMany({
    where: { id: { in: events.map((e) => e.entityId) } },
    select: { id: true, name: true },
  })) {
    entityTitles.set(s.id, s.name);
  }

  const traceChains = filters.key ? await traceByExternalKey(workspaceId, filters.key) : null;

  const base = `/workspaces/${workspaceId}/projects/${projectId}/audit`;

  return (
    <div className="min-h-screen bg-paper px-6 py-16">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6">
          <Link
            href={`/workspaces/${workspaceId}/projects/${projectId}/review`}
            className="text-sm text-cobalt underline-offset-2 hover:underline"
          >
            ← Back to review
          </Link>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">Audit trail</h1>
          <p className="mt-2 text-base text-sub">
            Append-only log of everything that happened in {project.name} — who, what, when.
          </p>
        </div>

        {/* External-key trace search (8.2/8.3): paste PAY-141 / AB#5 / #12. */}
        <form method="get" action={base} className="mb-6 flex gap-2">
          <input
            name="key"
            defaultValue={filters.key ?? ''}
            placeholder="Trace an external key, e.g. PAY-141"
            className="w-72 rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
          <button
            type="submit"
            className="rounded-md bg-cobalt px-4 py-2 text-sm font-semibold text-white"
          >
            Trace
          </button>
        </form>

        {traceChains !== null ? (
          <div className="mb-8 rounded-md border border-cobalt bg-panel p-4">
            <h2 className="mb-3 text-base font-semibold text-ink">
              Trace: <span className="font-mono">{filters.key}</span>
            </h2>
            {traceChains.length === 0 ? (
              <p className="text-sm text-sub">No published item found with that key.</p>
            ) : (
              traceChains.map((chain) => (
                <div key={`${chain.targetTool}-${chain.externalKey}`} className="space-y-3 text-sm">
                  <p className="text-ink">
                    <a href={chain.externalUrl} className="font-mono font-bold text-cobalt">
                      {chain.externalKey} ↗
                    </a>{' '}
                    ({chain.targetTool}) — published {chain.publishedAt.toLocaleString()}
                  </p>
                  <p className="text-ink">
                    <span className="mr-2 rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] font-bold text-sub">
                      {chain.item.type}
                    </span>
                    {chain.item.title}
                    {chain.item.revisionChain.length > 0 ? (
                      <span className="ml-2 text-xs text-sub">
                        (regenerated ×{chain.item.revisionChain.length})
                      </span>
                    ) : null}
                  </p>
                  <div>
                    <p className="text-xs font-bold text-sub">REVIEW DECISIONS</p>
                    {chain.decisions.map((d, i) => (
                      <p key={i} className="text-xs text-ink">
                        {d.decision} by {d.actorName ?? d.actorEmail ?? 'unknown'} —{' '}
                        {d.createdAt.toLocaleString()}
                        {d.notes ? ` · ${d.notes}` : ''}
                      </p>
                    ))}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-sub">SOURCE CITATIONS</p>
                    {chain.sources.map((s) => (
                      <p key={s.rawRequirementId} className="text-xs text-ink">
                        <span className="font-semibold">{s.sourceName}</span>{' '}
                        <span className="font-mono text-sub">({s.sectionPath})</span> — “{s.excerpt}
                        ”
                      </p>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {/* Timeline filters */}
        <form method="get" action={base} className="mb-4 flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-1 text-sub">
            Action
            <input
              name="action"
              defaultValue={filters.action ?? ''}
              placeholder="e.g. published"
              className="rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-sub">
            Actor email
            <input
              name="actor"
              defaultValue={filters.actor ?? ''}
              className="rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-sub">
            From
            <input
              type="date"
              name="from"
              defaultValue={filters.from ?? ''}
              className="rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-sub">
            To
            <input
              type="date"
              name="to"
              defaultValue={filters.to ?? ''}
              className="rounded border border-line bg-panel px-2 py-1.5 text-sm text-ink"
            />
          </label>
          <button
            type="submit"
            className="rounded border border-line px-3 py-1.5 text-sm font-semibold text-ink"
          >
            Filter
          </button>
          {filters.action || filters.actor || filters.from || filters.to ? (
            <Link href={base} className="px-2 py-1.5 text-cobalt">
              Clear
            </Link>
          ) : null}
        </form>

        {events.length === 0 ? (
          <p className="text-sm text-sub">No audit events match this filter.</p>
        ) : (
          <ul className="space-y-1.5">
            {events.map((event) => (
              <li
                key={event.id}
                className="rounded-md border border-line bg-panel px-4 py-2.5 text-sm"
              >
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 font-mono text-xs text-sub">
                    {event.createdAt.toLocaleString()}
                  </span>
                  <span className="shrink-0 rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] font-bold text-sub">
                    {event.action}
                  </span>
                  <span className="min-w-0 truncate text-ink">
                    {entityTitles.get(event.entityId) ?? event.entityId}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-sub">
                    {event.actor?.name ??
                      (event.actorType === 'AI'
                        ? 'AI'
                        : event.actorType === 'SYSTEM'
                          ? 'system'
                          : 'unknown user')}
                  </span>
                </div>
                {event.beforeState || event.afterState ? (
                  <p className="mt-1 truncate font-mono text-[11px] text-sub">
                    {event.beforeState ? `before: ${JSON.stringify(event.beforeState)} ` : ''}
                    {event.afterState ? `after: ${JSON.stringify(event.afterState)}` : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
