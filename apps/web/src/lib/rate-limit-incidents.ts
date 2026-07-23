import { prisma } from '@/lib/prisma';

export interface RateLimitIncident {
  id: string;
  tool: string;
  workspaceId: string;
  workspaceName: string;
  statusCode: number | null;
  waitSeconds: number | null;
  retryCount: number | null;
  createdAt: Date;
}

export interface RateLimitSummaryRow {
  tool: string;
  workspaceId: string;
  workspaceName: string;
  incidentCount: number;
  mostRecentAt: Date;
}

const RATE_LIMIT_ACTION = 'connector.rate_limited';

export async function getRecentRateLimitIncidents(limit = 200): Promise<RateLimitIncident[]> {
  const events = await prisma.auditEvent.findMany({
    where: { action: RATE_LIMIT_ACTION },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { workspace: { select: { name: true } } },
  });

  return events.map((e) => {
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    return {
      id: e.id,
      tool: e.entityType,
      workspaceId: e.workspaceId,
      workspaceName: e.workspace.name,
      statusCode: typeof meta.status_code === 'number' ? meta.status_code : null,
      waitSeconds: typeof meta.wait_seconds === 'number' ? meta.wait_seconds : null,
      retryCount: typeof meta.retry_count === 'number' ? meta.retry_count : null,
      createdAt: e.createdAt,
    };
  });
}

export async function getRateLimitSummary(): Promise<RateLimitSummaryRow[]> {
  const grouped = await prisma.auditEvent.groupBy({
    by: ['entityType', 'workspaceId'],
    where: { action: RATE_LIMIT_ACTION },
    _count: { _all: true },
    _max: { createdAt: true },
  });

  const workspaceIds = [...new Set(grouped.map((g) => g.workspaceId))];
  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: workspaceIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(workspaces.map((w) => [w.id, w.name]));

  return grouped
    .map((g) => ({
      tool: g.entityType,
      workspaceId: g.workspaceId,
      workspaceName: nameById.get(g.workspaceId) ?? g.workspaceId,
      incidentCount: g._count._all,
      mostRecentAt: g._max.createdAt ?? new Date(0),
    }))
    .sort((a, b) => b.incidentCount - a.incidentCount);
}
