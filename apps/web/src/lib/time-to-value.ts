import { prisma } from './prisma';

const TARGET_MINUTES = 15;

export interface TimeToValueRow {
  workspaceId: string;
  workspaceName: string;
  createdAt: Date;
  firstGenerationAt: Date | null;
  minutesToValue: number | null;
  metTarget: boolean | null;
}

/** Issue 10.10: time-to-first-value per workspace, newest signups first. A
 * workspace with firstGenerationAt = null hasn't generated anything yet. */
export async function getTimeToValueRows(limit = 50): Promise<TimeToValueRow[]> {
  const workspaces = await prisma.workspace.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, name: true, createdAt: true, firstGenerationAt: true },
  });

  return workspaces.map((ws) => {
    const minutesToValue = ws.firstGenerationAt
      ? Math.round((ws.firstGenerationAt.getTime() - ws.createdAt.getTime()) / 60000)
      : null;
    return {
      workspaceId: ws.id,
      workspaceName: ws.name,
      createdAt: ws.createdAt,
      firstGenerationAt: ws.firstGenerationAt,
      minutesToValue,
      metTarget: minutesToValue === null ? null : minutesToValue <= TARGET_MINUTES,
    };
  });
}

export async function getTimeToValueSummary(): Promise<{
  target: number;
  reached: number;
  total: number;
  medianMinutes: number | null;
}> {
  const rows = await getTimeToValueRows(500);
  const withValue = rows.filter((r) => r.minutesToValue !== null);
  const reached = withValue.filter((r) => r.metTarget).length;
  const sorted = withValue.map((r) => r.minutesToValue as number).sort((a, b) => a - b);
  const medianMinutes =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { target: TARGET_MINUTES, reached, total: withValue.length, medianMinutes };
}
