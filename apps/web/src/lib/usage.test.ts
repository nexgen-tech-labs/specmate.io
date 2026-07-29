import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import { getWorkspaceUsageSummary } from './usage';

describe('getWorkspaceUsageSummary', () => {
  let starterWs: { id: string };
  let enterpriseWs: { id: string };
  let project: { id: string };
  let draftItem: { id: string };

  beforeAll(async () => {
    starterWs = await prisma.workspace.create({
      data: { name: 'Usage Test Starter', pricingTier: 'STARTER' },
    });
    enterpriseWs = await prisma.workspace.create({
      data: { name: 'Usage Test Enterprise', pricingTier: 'ENTERPRISE' },
    });
    project = await prisma.project.create({
      data: { workspaceId: starterWs.id, name: 'Usage Test Project' },
    });
    draftItem = await prisma.draftItem.create({
      data: {
        projectId: project.id,
        type: 'STORY',
        title: 'x',
        description: 'x',
        status: 'APPROVED',
      },
    });
  });

  afterAll(async () => {
    await prisma.publishedItem.deleteMany({ where: { draftItemId: draftItem.id } });
    await prisma.draftItem.deleteMany({ where: { id: draftItem.id } });
    await prisma.project.deleteMany({ where: { id: project.id } });
    await prisma.workspace.deleteMany({ where: { id: { in: [starterWs.id, enterpriseWs.id] } } });
  });

  it('returns zero usage with correct STARTER quota when nothing published yet', async () => {
    const summary = await getWorkspaceUsageSummary(starterWs.id);
    expect(summary.publishedItemCount).toBe(0);
    expect(summary.includedItems).toBe(50);
    expect(summary.remaining).toBe(50);
    expect(summary.overageCount).toBe(0);
    expect(summary.percentUsed).toBe(0);
    expect(summary.tier).toBe('STARTER');
  });

  it('counts PublishedItem rows created within the current UTC month for STARTER, computing remaining/overage/percent', async () => {
    await prisma.publishedItem.create({
      data: {
        draftItemId: draftItem.id,
        targetTool: 'JIRA',
        externalKey: 'KAN-1',
        externalUrl: 'https://example.atlassian.net/browse/KAN-1',
      },
    });
    const summary = await getWorkspaceUsageSummary(starterWs.id);
    expect(summary.publishedItemCount).toBe(1);
    expect(summary.remaining).toBe(49);
    expect(summary.overageCount).toBe(0);
    expect(summary.percentUsed).toBe(2); // round(1/50 * 100)
  });

  it('excludes soft-deleted PublishedItem rows from the count', async () => {
    const deleted = await prisma.publishedItem.create({
      data: {
        draftItemId: draftItem.id,
        targetTool: 'JIRA',
        externalKey: 'KAN-2',
        externalUrl: 'https://example.atlassian.net/browse/KAN-2',
        deletedAt: new Date(),
      },
    });
    const summary = await getWorkspaceUsageSummary(starterWs.id);
    expect(summary.publishedItemCount).toBe(1); // unchanged — KAN-1 only
    await prisma.publishedItem.delete({ where: { id: deleted.id } });
  });

  it('reports unlimited (null quota fields) for ENTERPRISE regardless of usage', async () => {
    const summary = await getWorkspaceUsageSummary(enterpriseWs.id);
    expect(summary.includedItems).toBeNull();
    expect(summary.remaining).toBeNull();
    expect(summary.overageCount).toBe(0);
    expect(summary.percentUsed).toBeNull();
    expect(summary.tier).toBe('ENTERPRISE');
  });

  it('reports overageCount and percentUsed over 100 when usage exceeds the STARTER quota', async () => {
    const extraItems = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        prisma.publishedItem.create({
          data: {
            draftItemId: draftItem.id,
            targetTool: 'JIRA',
            externalKey: `KAN-OVER-${i}`,
            externalUrl: `https://example.atlassian.net/browse/KAN-OVER-${i}`,
          },
        }),
      ),
    );
    const summary = await getWorkspaceUsageSummary(starterWs.id);
    expect(summary.publishedItemCount).toBe(51); // 1 (from earlier test) + 50
    expect(summary.remaining).toBe(0);
    expect(summary.overageCount).toBe(1);
    expect(summary.percentUsed).toBe(102);
    await prisma.publishedItem.deleteMany({
      where: { id: { in: extraItems.map((i) => i.id) } },
    });
  });
});
