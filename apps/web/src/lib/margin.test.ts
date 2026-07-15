// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import { getMarginRows } from './margin';
import { STARTER_BASE_USD, STARTER_INCLUDED_ITEMS, STARTER_OVERAGE_PER_ITEM_USD } from './pricing';

describe('margin (Issue 10.9)', () => {
  let starterBreach: { id: string };
  let starterHealthy: { id: string };
  let enterpriseWithBase: { id: string };

  function startOfCurrentMonthUtc(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  beforeAll(async () => {
    const periodStart = startOfCurrentMonthUtc();
    const periodEnd = new Date(
      Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1),
    );

    // Starter workspace whose AI cost blows past its tier-derived revenue.
    starterBreach = await prisma.workspace.create({
      data: { name: 'Margin Starter Breach', pricingTier: 'STARTER' },
    });
    // Starter workspace comfortably under its tier-derived revenue.
    starterHealthy = await prisma.workspace.create({
      data: { name: 'Margin Starter Healthy', pricingTier: 'STARTER' },
    });
    // Enterprise workspace billed via a real Stripe subscription base price.
    enterpriseWithBase = await prisma.workspace.create({
      data: {
        name: 'Margin Enterprise',
        pricingTier: 'ENTERPRISE',
        subscriptionBaseUsd: 500,
      },
    });

    const overItems = STARTER_INCLUDED_ITEMS + 20;
    const expectedBreachRevenue = STARTER_BASE_USD + 20 * STARTER_OVERAGE_PER_ITEM_USD;

    await prisma.usagePeriod.createMany({
      data: [
        {
          workspaceId: starterBreach.id,
          periodStart,
          periodEnd,
          publishedItemCount: overItems,
        },
        {
          workspaceId: starterHealthy.id,
          periodStart,
          periodEnd,
          publishedItemCount: 1,
        },
      ],
    });

    const project = await prisma.project.create({
      data: { workspaceId: starterBreach.id, name: 'Margin Project' },
    });
    await prisma.aiCallLog.create({
      data: {
        workspaceId: starterBreach.id,
        projectId: project.id,
        task: 'extraction',
        model: 'claude-opus-4-8',
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        // Well over expectedBreachRevenue -> should be flagged.
        costUsd: expectedBreachRevenue * 2,
        latencyMs: 100,
      },
    });
    await prisma.aiCallLog.create({
      data: {
        workspaceId: starterHealthy.id,
        projectId: project.id,
        task: 'extraction',
        model: 'claude-opus-4-8',
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 1, // trivial relative to STARTER_BASE_USD
        latencyMs: 100,
      },
    });
  });

  afterAll(async () => {
    const ids = [starterBreach.id, starterHealthy.id, enterpriseWithBase.id];
    await prisma.aiCallLog.deleteMany({ where: { workspaceId: { in: ids } } });
    await prisma.usagePeriod.deleteMany({ where: { workspaceId: { in: ids } } });
    await prisma.project.deleteMany({ where: { workspaceId: { in: ids } } });
    await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
  });

  it('derives Starter effective revenue from real tier pricing and real usage, and flags breaches', async () => {
    const rows = await getMarginRows(0.5);
    const breachRow = rows.find((r) => r.workspaceId === starterBreach.id);
    expect(breachRow).toBeDefined();
    expect(breachRow?.effectiveRevenueUsd).toBe(
      STARTER_BASE_USD + 20 * STARTER_OVERAGE_PER_ITEM_USD,
    );
    expect(breachRow?.isBreach).toBe(true);

    const healthyRow = rows.find((r) => r.workspaceId === starterHealthy.id);
    expect(healthyRow).toBeDefined();
    expect(healthyRow?.effectiveRevenueUsd).toBe(STARTER_BASE_USD);
    expect(healthyRow?.isBreach).toBe(false);
  });

  it('uses real Stripe subscription base price for Enterprise workspaces, not the tier formula', async () => {
    const rows = await getMarginRows(0.5);
    const enterpriseRow = rows.find((r) => r.workspaceId === enterpriseWithBase.id);
    expect(enterpriseRow).toBeDefined();
    expect(enterpriseRow?.effectiveRevenueUsd).toBe(500);
    expect(enterpriseRow?.aiCostUsd).toBe(0);
    expect(enterpriseRow?.isBreach).toBe(false);
  });
});
