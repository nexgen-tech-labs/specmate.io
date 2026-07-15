/**
 * Margin flagging (Issue 10.9 AC 3): "A workspace with disproportionate AI
 * cost relative to its tier is flagged internally before it becomes a margin
 * problem." Extends the Issue 1.6 cost-to-revenue dashboard with real tier
 * pricing instead of only the manually-entered planRevenueUsd fallback.
 *
 * effectiveRevenueUsd:
 * - STARTER: estimateStarterMonthlyUsd(current month's published-item count) —
 *   the real pricing formula (base + overage) applied to real usage, not a
 *   hand-entered number.
 * - ENTERPRISE: subscriptionBaseUsd (from a real Stripe subscription) if set,
 *   else planRevenueUsd (the pre-Stripe manual fallback for custom/sales deals
 *   not run through Stripe at all).
 */
import { prisma } from './prisma';
import { estimateStarterMonthlyUsd } from './pricing';

const DEFAULT_ALERT_THRESHOLD_RATIO = 0.5;

function getAlertThresholdRatio(): number {
  const raw = process.env.AI_COST_ALERT_THRESHOLD_RATIO;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ALERT_THRESHOLD_RATIO;
}

export interface MarginRow {
  workspaceId: string;
  workspaceName: string;
  pricingTier: 'STARTER' | 'ENTERPRISE';
  aiCostUsd: number;
  publishedItemCount: number;
  effectiveRevenueUsd: number | null;
  ratio: number | null;
  isBreach: boolean;
}

function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** One row per active workspace for the current month: real AI cost, real
 * published-item usage, and the tier-derived effective revenue + breach flag. */
export async function getMarginRows(
  thresholdRatio = getAlertThresholdRatio(),
): Promise<MarginRow[]> {
  const startOfMonth = startOfCurrentMonthUtc();

  const workspaces = await prisma.workspace.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      pricingTier: true,
      subscriptionBaseUsd: true,
      planRevenueUsd: true,
    },
  });
  if (workspaces.length === 0) return [];

  const costGrouped = await prisma.aiCallLog.groupBy({
    by: ['workspaceId'],
    where: { createdAt: { gte: startOfMonth } },
    _sum: { costUsd: true },
  });
  const costById = new Map(costGrouped.map((g) => [g.workspaceId, Number(g._sum.costUsd ?? 0)]));

  const usagePeriods = await prisma.usagePeriod.findMany({
    where: { periodStart: startOfMonth },
    select: { workspaceId: true, publishedItemCount: true },
  });
  const usageById = new Map(usagePeriods.map((u) => [u.workspaceId, u.publishedItemCount]));

  return workspaces.map((ws) => {
    const aiCostUsd = costById.get(ws.id) ?? 0;
    const publishedItemCount = usageById.get(ws.id) ?? 0;

    let effectiveRevenueUsd: number | null;
    if (ws.pricingTier === 'STARTER') {
      effectiveRevenueUsd = estimateStarterMonthlyUsd(publishedItemCount);
    } else {
      effectiveRevenueUsd =
        ws.subscriptionBaseUsd != null
          ? Number(ws.subscriptionBaseUsd)
          : ws.planRevenueUsd != null
            ? Number(ws.planRevenueUsd)
            : null;
    }

    const ratio =
      effectiveRevenueUsd != null && effectiveRevenueUsd > 0
        ? aiCostUsd / effectiveRevenueUsd
        : null;

    return {
      workspaceId: ws.id,
      workspaceName: ws.name,
      pricingTier: ws.pricingTier,
      aiCostUsd,
      publishedItemCount,
      effectiveRevenueUsd,
      ratio,
      isBreach: ratio !== null && ratio >= thresholdRatio,
    };
  });
}
