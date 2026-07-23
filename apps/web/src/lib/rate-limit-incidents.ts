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
  const events = await prisma.auditEvent.findMany({
    where: { action: RATE_LIMIT_ACTION },
    orderBy: { createdAt: 'desc' },
    include: { workspace: { select: { name: true } } },
  });

  const grouped = new Map<string, RateLimitSummaryRow>();
  for (const e of events) {
    const key = `${e.entityType}::${e.workspaceId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.incidentCount += 1;
      if (e.createdAt > existing.mostRecentAt) existing.mostRecentAt = e.createdAt;
    } else {
      grouped.set(key, {
        tool: e.entityType,
        workspaceId: e.workspaceId,
        workspaceName: e.workspace.name,
        incidentCount: 1,
        mostRecentAt: e.createdAt,
      });
    }
  }

  return Array.from(grouped.values()).sort((a, b) => b.incidentCount - a.incidentCount);
}
