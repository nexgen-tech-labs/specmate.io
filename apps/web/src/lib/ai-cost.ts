import { prisma } from './prisma';

const DEFAULT_ALERT_THRESHOLD_RATIO = 0.5;

function getAlertThresholdRatio(): number {
  const raw = process.env.AI_COST_ALERT_THRESHOLD_RATIO;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ALERT_THRESHOLD_RATIO;
}

export interface CostSummary {
  workspaceId: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
}

export interface WorkspaceCostRanking {
  workspaceId: string;
  workspaceName: string;
  totalCostUsd: number;
  callCount: number;
  planRevenueUsd: number | null;
}

export interface CostRevenueBreach {
  workspaceId: string;
  workspaceName: string;
  totalCostUsd: number;
  planRevenueUsd: number;
  ratio: number;
}

function monthRange(year: number, month: number): { gte: Date; lt: Date } {
  // month is 1-indexed (January = 1) to match calendar convention at call sites.
  const gte = new Date(Date.UTC(year, month - 1, 1));
  const lt = new Date(Date.UTC(year, month, 1));
  return { gte, lt };
}

/** Acceptance criterion: any workspace's total AI spend for a given month, queried in one place. */
export async function getWorkspaceCostForMonth(
  workspaceId: string,
  year: number,
  month: number,
): Promise<CostSummary> {
  const { gte, lt } = monthRange(year, month);

  const result = await prisma.aiCallLog.aggregate({
    where: { workspaceId, createdAt: { gte, lt } },
    _sum: { costUsd: true, inputTokens: true, outputTokens: true },
    _count: { _all: true },
  });

  return {
    workspaceId,
    totalCostUsd: Number(result._sum.costUsd ?? 0),
    totalInputTokens: result._sum.inputTokens ?? 0,
    totalOutputTokens: result._sum.outputTokens ?? 0,
    callCount: result._count._all,
  };
}

/** Powers the internal dashboard's "top 10 workspaces by AI cost" view, current month by default. */
export async function getTopWorkspacesByCost(
  limit = 10,
  since?: Date,
): Promise<WorkspaceCostRanking[]> {
  const startOfMonth =
    since ?? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

  const grouped = await prisma.aiCallLog.groupBy({
    by: ['workspaceId'],
    where: { createdAt: { gte: startOfMonth } },
    _sum: { costUsd: true },
    _count: { _all: true },
    orderBy: { _sum: { costUsd: 'desc' } },
    take: limit,
  });

  if (grouped.length === 0) return [];

  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: grouped.map((g) => g.workspaceId) } },
    select: { id: true, name: true, planRevenueUsd: true },
  });
  const byId = new Map(workspaces.map((w) => [w.id, w]));

  return grouped.map((g) => {
    const workspace = byId.get(g.workspaceId);
    return {
      workspaceId: g.workspaceId,
      workspaceName: workspace?.name ?? 'Unknown workspace',
      totalCostUsd: Number(g._sum.costUsd ?? 0),
      callCount: g._count._all,
      planRevenueUsd: workspace?.planRevenueUsd != null ? Number(workspace.planRevenueUsd) : null,
    };
  });
}

/** Flags workspaces whose current-month AI cost exceeds thresholdRatio of their planRevenueUsd. */
export async function getCostToRevenueBreaches(
  thresholdRatio = getAlertThresholdRatio(),
): Promise<CostRevenueBreach[]> {
  const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

  const workspacesWithRevenue = await prisma.workspace.findMany({
    where: { planRevenueUsd: { not: null }, deletedAt: null },
    select: { id: true, name: true, planRevenueUsd: true },
  });
  if (workspacesWithRevenue.length === 0) return [];

  const grouped = await prisma.aiCallLog.groupBy({
    by: ['workspaceId'],
    where: {
      createdAt: { gte: startOfMonth },
      workspaceId: { in: workspacesWithRevenue.map((w) => w.id) },
    },
    _sum: { costUsd: true },
  });
  const costById = new Map(grouped.map((g) => [g.workspaceId, Number(g._sum.costUsd ?? 0)]));

  const breaches: CostRevenueBreach[] = [];
  for (const workspace of workspacesWithRevenue) {
    const revenue = Number(workspace.planRevenueUsd);
    if (revenue <= 0) continue;
    const cost = costById.get(workspace.id) ?? 0;
    const ratio = cost / revenue;
    if (ratio >= thresholdRatio) {
      breaches.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        totalCostUsd: cost,
        planRevenueUsd: revenue,
        ratio,
      });
    }
  }
  return breaches;
}
