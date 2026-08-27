import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import {
  getActivityFeed,
  getAwaitingReviewSummary,
  getIntegrationsSummary,
  getOrCreateDefaultProjectId,
  getPipelineCounts,
  getQualityScoreSummary,
  getRecentlyPublishedBatches,
  getSourcesSummary,
} from './dashboard';

describe('dashboard aggregation', () => {
  let org: { id: string };
  let workspace: { id: string };
  let projectA: { id: string };
  let projectB: { id: string };
  let user: { id: string };

  beforeAll(async () => {
    org = await prisma.organization.create({ data: { name: 'Dashboard Test Org' } });
    workspace = await prisma.workspace.create({
      data: { name: 'Dashboard Test WS', organizationId: org.id },
    });
    projectA = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'Dashboard Test Project A' },
    });
    projectB = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'Dashboard Test Project B' },
    });
    user = await prisma.user.create({
      data: {
        email: `dashboard-test-${Date.now()}@test.local`,
        name: 'Dash User',
        passwordHash: 'x',
      },
    });

    await prisma.source.create({
      data: { projectId: projectA.id, name: 'Source A1', kind: 'DOCX', status: 'PARSED' },
    });
    await prisma.source.create({
      data: { projectId: projectB.id, name: 'Source B1', kind: 'TXT', status: 'QUEUED' },
    });

    const pending1 = await prisma.draftItem.create({
      data: {
        projectId: projectA.id,
        type: 'STORY',
        title: 's1',
        description: 'd',
        status: 'PENDING',
        qualityScore: 90,
      },
    });
    await prisma.draftItem.create({
      data: {
        projectId: projectA.id,
        type: 'EPIC',
        title: 'e1',
        description: 'd',
        status: 'PENDING',
        qualityScore: 60,
      },
    });
    const approved1 = await prisma.draftItem.create({
      data: {
        projectId: projectB.id,
        type: 'TASK',
        title: 't1',
        description: 'd',
        status: 'APPROVED',
        qualityScore: 80,
      },
    });

    await prisma.publishedItem.create({
      data: {
        draftItemId: approved1.id,
        targetTool: 'JIRA',
        externalKey: 'PAY-1',
        externalUrl: 'https://x/PAY-1',
      },
    });

    await prisma.auditEvent.create({
      data: {
        workspaceId: workspace.id,
        actorUserId: user.id,
        action: 'draft_item.approved',
        entityType: 'DraftItem',
        entityId: pending1.id,
      },
    });

    const connection = await prisma.connection.create({
      data: { organizationId: org.id, toolKey: 'jira', authMethod: 'OAUTH' },
    });
    await prisma.workspaceConnectionScope.create({
      data: {
        workspaceId: workspace.id,
        connectionId: connection.id,
        scopeValue: 'PAY',
        scopeLabel: 'Payments (PAY)',
      },
    });
  });

  afterAll(async () => {
    await prisma.workspaceConnectionScope.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.connection.deleteMany({ where: { organizationId: org.id } });
    // AuditEvent is trigger-protected (append-only, Issue 8.1); test-database
    // cleanup is the one sanctioned use of the maintenance GUC, and it must
    // share the trigger's session — hence a single transaction (see
    // rate-limit-incidents.test.ts for the established precedent).
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL specmate.maintenance = 'on'`),
      prisma.auditEvent.deleteMany({ where: { workspaceId: workspace.id } }),
    ]);
    await prisma.publishedItem.deleteMany({
      where: { draftItem: { project: { workspaceId: workspace.id } } },
    });
    await prisma.draftItem.deleteMany({ where: { project: { workspaceId: workspace.id } } });
    await prisma.source.deleteMany({ where: { project: { workspaceId: workspace.id } } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.project.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  });

  it('getPipelineCounts aggregates across all accessible projects when unrestricted (null scope)', async () => {
    const summary = await getPipelineCounts(workspace.id, null);
    const byKey = Object.fromEntries(summary.stages.map((s) => [s.key, s.count]));
    expect(byKey.ingest).toBe(2); // 1 source in each project
    expect(byKey.generation).toBe(3); // 3 draft items total
    expect(byKey.review).toBe(2); // 2 PENDING
    expect(byKey.publish).toBe(1); // 1 published
    expect(summary.activeKey).toBe('publish'); // furthest-along stage with data
  });

  it('getPipelineCounts respects team scoping — a restricted member only sees their project', async () => {
    const summary = await getPipelineCounts(workspace.id, new Set([projectA.id]));
    const byKey = Object.fromEntries(summary.stages.map((s) => [s.key, s.count]));
    expect(byKey.ingest).toBe(1); // only projectA's source
    expect(byKey.generation).toBe(2); // only projectA's 2 draft items
    expect(byKey.review).toBe(2);
    expect(byKey.publish).toBe(0); // the published item is in projectB, out of scope
  });

  it('getSourcesSummary counts and lists sources across accessible projects', async () => {
    const summary = await getSourcesSummary(workspace.id, null);
    expect(summary.total).toBe(2);
    expect(summary.recent.map((s) => s.name).sort()).toEqual(['Source A1', 'Source B1']);
  });

  it('getSourcesSummary respects team scoping', async () => {
    const summary = await getSourcesSummary(workspace.id, new Set([projectB.id]));
    expect(summary.total).toBe(1);
    expect(summary.recent[0].name).toBe('Source B1');
  });

  it('getAwaitingReviewSummary breaks down PENDING items by type', async () => {
    const summary = await getAwaitingReviewSummary(workspace.id, null);
    expect(summary.total).toBe(2);
    expect(summary.breakdown).toEqual(
      expect.arrayContaining([
        { type: 'STORY', count: 1 },
        { type: 'EPIC', count: 1 },
      ]),
    );
  });

  it('getQualityScoreSummary computes average and bands', async () => {
    const summary = await getQualityScoreSummary(workspace.id, null);
    expect(summary.scoredCount).toBe(3);
    expect(summary.average).toBe(Math.round((90 + 60 + 80) / 3));
    const byLabel = Object.fromEntries(summary.bands.map((b) => [b.label, b.count]));
    expect(byLabel['Ready to publish']).toBe(1); // 90
    expect(byLabel['Needs detail']).toBe(1); // 80
    expect(byLabel['Missing criteria']).toBe(1); // 60
  });

  it('getRecentlyPublishedBatches groups by tool and time bucket', async () => {
    const batches = await getRecentlyPublishedBatches(workspace.id, null);
    expect(batches).toHaveLength(1);
    expect(batches[0].targetTool).toBe('JIRA');
    expect(batches[0].count).toBe(1);
  });

  it('getActivityFeed reads workspace-scoped AuditEvent rows directly', async () => {
    const feed = await getActivityFeed(workspace.id);
    expect(feed).toHaveLength(1);
    expect(feed[0].action).toBe('draft_item.approved');
    expect(feed[0].actorName).toBe('Dash User');
  });

  it("getIntegrationsSummary reflects org-level connections and this workspace's scope pick", async () => {
    const summary = await getIntegrationsSummary(org.id, workspace.id);
    const jira = summary.find((s) => s.toolKey === 'jira');
    expect(jira?.connected).toBe(true);
    expect(jira?.scopeLabel).toBe('Payments (PAY)');
    const github = summary.find((s) => s.toolKey === 'github');
    expect(github?.connected).toBe(false);
  });

  it('getIntegrationsSummary returns all-disconnected when the workspace has no organization', async () => {
    const summary = await getIntegrationsSummary(null, workspace.id);
    expect(summary.every((s) => !s.connected)).toBe(true);
  });

  it('getOrCreateDefaultProjectId returns the most recently created project when several exist', async () => {
    // projectB was created after projectA in beforeAll.
    const id = await getOrCreateDefaultProjectId(workspace.id, workspace.id);
    expect(id).toBe(projectB.id);
  });

  it('getOrCreateDefaultProjectId creates one lazily for a workspace with zero projects', async () => {
    const emptyWs = await prisma.workspace.create({
      data: { name: 'Empty WS For Default Project' },
    });
    try {
      const before = await prisma.project.count({ where: { workspaceId: emptyWs.id } });
      expect(before).toBe(0);

      const id = await getOrCreateDefaultProjectId(emptyWs.id, emptyWs.name);
      const project = await prisma.project.findUniqueOrThrow({ where: { id } });
      expect(project.workspaceId).toBe(emptyWs.id);
      expect(project.name).toBe(emptyWs.name);

      // Idempotent: a second call reuses the same project rather than creating another.
      const idAgain = await getOrCreateDefaultProjectId(emptyWs.id, emptyWs.name);
      expect(idAgain).toBe(id);
      expect(await prisma.project.count({ where: { workspaceId: emptyWs.id } })).toBe(1);
    } finally {
      await prisma.project.deleteMany({ where: { workspaceId: emptyWs.id } });
      await prisma.workspace.deleteMany({ where: { id: emptyWs.id } });
    }
  });
});
