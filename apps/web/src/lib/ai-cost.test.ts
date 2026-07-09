import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import {
  getCostToRevenueBreaches,
  getTopWorkspacesByCost,
  getWorkspaceCostForMonth,
} from './ai-cost';

describe('ai-cost aggregation', () => {
  let workspaceA: { id: string };
  let workspaceB: { id: string };
  let workspaceNoRevenue: { id: string };
  let project: { id: string };

  beforeAll(async () => {
    workspaceA = await prisma.workspace.create({
      data: { name: 'Cost Test A', planRevenueUsd: 10 },
    });
    workspaceB = await prisma.workspace.create({
      data: { name: 'Cost Test B', planRevenueUsd: 1000 },
    });
    workspaceNoRevenue = await prisma.workspace.create({ data: { name: 'Cost Test No Revenue' } });

    // project is only needed to satisfy AiCallLog's FK — reuse across all three workspaces isn't
    // possible (FK requires matching workspaceId), so create one per workspace that needs rows.
    project = await prisma.project.create({
      data: { workspaceId: workspaceA.id, name: 'Proj A' },
    });

    const thisMonth = new Date();
    const lastMonth = new Date(
      Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 15),
    );

    await prisma.aiCallLog.createMany({
      data: [
        // Workspace A: $9 this month (90% of $10 revenue -> breach at default 50% threshold)
        {
          workspaceId: workspaceA.id,
          projectId: project.id,
          task: 'extraction',
          model: 'claude-opus-4-8',
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 9,
          latencyMs: 100,
        },
        // Workspace A: a call from last month — must be excluded from "this month" queries
        {
          workspaceId: workspaceA.id,
          projectId: project.id,
          task: 'extraction',
          model: 'claude-opus-4-8',
          inputTokens: 500,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 500,
          latencyMs: 100,
          createdAt: lastMonth,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.aiCallLog.deleteMany({
      where: { workspaceId: { in: [workspaceA.id, workspaceB.id, workspaceNoRevenue.id] } },
    });
    await prisma.project.deleteMany({ where: { workspaceId: workspaceA.id } });
    await prisma.workspace.deleteMany({
      where: { id: { in: [workspaceA.id, workspaceB.id, workspaceNoRevenue.id] } },
    });
  });

  it('sums cost for a workspace within the given month and excludes other months', async () => {
    const now = new Date();
    const summary = await getWorkspaceCostForMonth(
      workspaceA.id,
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
    );
    expect(summary.totalCostUsd).toBe(9);
    expect(summary.callCount).toBe(1);
  });

  it('ranks workspaces by cost this month, respecting the limit', async () => {
    const rankings = await getTopWorkspacesByCost(10);
    const workspaceARanking = rankings.find((r) => r.workspaceId === workspaceA.id);
    expect(workspaceARanking).toBeDefined();
    expect(workspaceARanking?.totalCostUsd).toBe(9);
    expect(workspaceARanking?.planRevenueUsd).toBe(10);

    const limited = await getTopWorkspacesByCost(1);
    expect(limited.length).toBeLessThanOrEqual(1);
  });

  it('flags a workspace whose cost/revenue ratio exceeds the threshold', async () => {
    const breaches = await getCostToRevenueBreaches(0.5);
    const breach = breaches.find((b) => b.workspaceId === workspaceA.id);
    expect(breach).toBeDefined();
    expect(breach?.ratio).toBeCloseTo(0.9, 5);
  });

  it('excludes workspaces with no planRevenueUsd from breach checks', async () => {
    const breaches = await getCostToRevenueBreaches(0.5);
    expect(breaches.find((b) => b.workspaceId === workspaceNoRevenue.id)).toBeUndefined();
  });

  it('does not flag a workspace comfortably under the threshold', async () => {
    const breaches = await getCostToRevenueBreaches(0.5);
    expect(breaches.find((b) => b.workspaceId === workspaceB.id)).toBeUndefined();
  });
});
