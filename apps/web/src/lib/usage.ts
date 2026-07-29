/**
 * Customer-facing usage tracking (Issue 12.4) — live-computed, never read from
 * the possibly-stale UsagePeriod.publishedItemCount (which is only refreshed
 * when POST /billing/meter-usage runs in apps/api, and there's no cron for
 * that yet). Counting PublishedItem rows directly on every call guarantees
 * this always matches what apps/api's metering would compute right now, and
 * therefore always matches what's actually billed (Issue 10.9) — no risk of
 * showing customers a number that later diverges from their invoice.
 *
 * Mirrors apps/api/app/services/billing/metering.py's period-boundary and
 * join logic exactly (UTC calendar month, PublishedItem -> DraftItem ->
 * Project -> workspaceId) — this is the second, TypeScript-side, of exactly
 * two places that logic exists; keep them in sync if either changes.
 */
import { prisma } from './prisma';
import { PRICING_TIERS, type PricingTierKey } from './pricing';

export interface UsageSummary {
  periodStart: string;
  periodEnd: string;
  publishedItemCount: number;
  includedItems: number | null;
  remaining: number | null;
  overageCount: number;
  percentUsed: number | null;
  tier: PricingTierKey;
}

function currentPeriodBoundsUtc(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function getWorkspaceUsageSummary(workspaceId: string): Promise<UsageSummary> {
  // Callers must have already verified workspace access (e.g. via requireWorkspaceRole)
  // before calling this — a nonexistent workspaceId here indicates a caller bug, not a
  // normal 404 case.
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { pricingTier: true },
  });
  const { start, end } = currentPeriodBoundsUtc();

  const publishedItemCount = await prisma.publishedItem.count({
    where: {
      deletedAt: null,
      createdAt: { gte: start, lt: end },
      draftItem: { project: { workspaceId } },
    },
  });

  const includedItems: number | null = PRICING_TIERS[workspace.pricingTier].includedItems;

  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    publishedItemCount,
    includedItems,
    remaining: includedItems === null ? null : Math.max(0, includedItems - publishedItemCount),
    overageCount: includedItems === null ? 0 : Math.max(0, publishedItemCount - includedItems),
    percentUsed:
      includedItems === null ? null : Math.round((publishedItemCount / includedItems) * 100),
    tier: workspace.pricingTier,
  };
}
