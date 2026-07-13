// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { traceByExternalKey, traceByItem, traceBySource } from './trace';

describe('trace chain resolution (Issue 8.2)', () => {
  let workspaceId: string;
  let projectId: string;
  let reviewerId: string;
  let sourceId: string;
  let itemId: string;
  let regeneratedItemId: string;

  beforeAll(async () => {
    const ws = await prisma.workspace.create({ data: { name: 'Trace Test WS' } });
    workspaceId = ws.id;
    const project = await prisma.project.create({ data: { workspaceId, name: 'Trace Project' } });
    projectId = project.id;
    const reviewer = await prisma.user.create({
      data: { email: `trace-rev-${Date.now()}@test.local`, name: 'Tracy', passwordHash: 'x' },
    });
    reviewerId = reviewer.id;

    const source = await prisma.source.create({
      data: { projectId, name: 'spec.docx', kind: 'DOCX', status: 'PARSED' },
    });
    sourceId = source.id;
    const fragment = await prisma.rawRequirement.create({
      data: {
        sourceId,
        text: 'The system shall let customers save cards.',
        sectionPath: '3.2 Wallet',
        order: 1,
      },
    });

    // Original item, superseded by a regeneration (revisionOfId chain, Issue 3.9).
    const original = await prisma.draftItem.create({
      data: {
        projectId,
        type: 'STORY',
        title: 'Saved cards (v1)',
        description: 'd',
        status: 'PENDING',
        deletedAt: new Date(),
      },
    });
    const item = await prisma.draftItem.create({
      data: {
        projectId,
        type: 'STORY',
        title: 'Saved cards (regenerated)',
        description: 'd',
        status: 'APPROVED',
        revisionOfId: original.id,
      },
    });
    itemId = item.id;
    regeneratedItemId = original.id;

    await prisma.reviewDecision.create({
      data: { draftItemId: itemId, decision: 'APPROVED', actorUserId: reviewerId },
    });
    const published = await prisma.publishedItem.create({
      data: {
        draftItemId: itemId,
        targetTool: 'JIRA',
        externalKey: 'PAY-141',
        externalUrl: 'https://example.atlassian.net/browse/PAY-141',
      },
    });
    await prisma.traceLink.create({
      data: {
        sourceId,
        rawRequirementId: fragment.id,
        draftItemId: itemId,
        publishedItemId: published.id,
      },
    });
  });

  afterAll(async () => {
    await prisma.traceLink.deleteMany({ where: { sourceId } });
    await prisma.publishedItem.deleteMany({ where: { draftItemId: itemId } });
    await prisma.reviewDecision.deleteMany({ where: { draftItemId: itemId } });
    await prisma.draftItem.deleteMany({ where: { projectId } });
    await prisma.rawRequirement.deleteMany({ where: { sourceId } });
    await prisma.source.deleteMany({ where: { id: sourceId } });
    await prisma.user.deleteMany({ where: { id: reviewerId } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  it('resolves the full chain from an external key back to source locations', async () => {
    const chains = await traceByExternalKey(workspaceId, 'PAY-141');
    expect(chains).toHaveLength(1);
    const chain = chains[0];
    expect(chain.item.title).toBe('Saved cards (regenerated)');
    expect(chain.decisions[0].decision).toBe('APPROVED');
    expect(chain.decisions[0].actorName).toBe('Tracy');
    expect(chain.sources[0].sourceName).toBe('spec.docx');
    expect(chain.sources[0].sectionPath).toBe('3.2 Wallet');
    // Regeneration chain preserved (8.2 AC).
    expect(chain.item.revisionChain).toEqual([regeneratedItemId]);
  });

  it('is case-insensitive and returns [] for unknown keys', async () => {
    expect(await traceByExternalKey(workspaceId, 'pay-141')).toHaveLength(1);
    expect(await traceByExternalKey(workspaceId, 'NOPE-1')).toHaveLength(0);
  });

  it('resolves every downstream item and external key from a source', async () => {
    const contributions = await traceBySource(workspaceId, sourceId);
    expect(contributions).not.toBeNull();
    expect(contributions).toHaveLength(1); // superseded revision excluded
    expect(contributions![0].itemTitle).toBe('Saved cards (regenerated)');
    expect(contributions![0].externalKeys).toEqual([
      { key: 'PAY-141', url: 'https://example.atlassian.net/browse/PAY-141', tool: 'JIRA' },
    ]);
  });

  it('resolves an item-level trace for the review-queue panel', async () => {
    const trace = await traceByItem(workspaceId, itemId);
    expect(trace).not.toBeNull();
    expect(trace!.published[0].key).toBe('PAY-141');
    expect(trace!.sources[0].sectionPath).toBe('3.2 Wallet');
  });

  it('scopes lookups to the workspace', async () => {
    const other = await prisma.workspace.create({ data: { name: 'Other WS' } });
    expect(await traceByExternalKey(other.id, 'PAY-141')).toHaveLength(0);
    expect(await traceBySource(other.id, sourceId)).toBeNull();
    await prisma.workspace.delete({ where: { id: other.id } });
  });
});
