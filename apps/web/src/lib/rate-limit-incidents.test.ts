import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import { getRateLimitSummary, getRecentRateLimitIncidents } from './rate-limit-incidents';

describe('rate-limit-incidents aggregation', () => {
  let workspaceA: { id: string };
  let workspaceB: { id: string };

  beforeAll(async () => {
    workspaceA = await prisma.workspace.create({ data: { name: 'Rate Limit Test WS A' } });
    workspaceB = await prisma.workspace.create({ data: { name: 'Rate Limit Test WS B' } });

    const now = new Date();
    const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);

    await prisma.auditEvent.createMany({
      data: [
        // Workspace A / jira: two rate-limit incidents, should be grouped together.
        {
          workspaceId: workspaceA.id,
          actorType: 'SYSTEM',
          action: 'connector.rate_limited',
          entityType: 'jira',
          entityId: 'jira',
          metadata: { status_code: 429, wait_seconds: 1.5, retry_count: 1 },
          createdAt: secondsAgo(300),
        },
        {
          workspaceId: workspaceA.id,
          actorType: 'SYSTEM',
          action: 'connector.rate_limited',
          entityType: 'jira',
          entityId: 'jira',
          metadata: { status_code: 429, wait_seconds: 3, retry_count: 2 },
          createdAt: secondsAgo(60),
        },
        // Workspace A / github: a single distinct incident.
        {
          workspaceId: workspaceA.id,
          actorType: 'SYSTEM',
          action: 'connector.rate_limited',
          entityType: 'github',
          entityId: 'github',
          metadata: { status_code: 429, wait_seconds: 0.5, retry_count: 0 },
          createdAt: secondsAgo(180),
        },
        // Workspace B / jira: separate (tool, workspace) pair from workspace A's jira rows.
        {
          workspaceId: workspaceB.id,
          actorType: 'SYSTEM',
          action: 'connector.rate_limited',
          entityType: 'jira',
          entityId: 'jira',
          metadata: { status_code: 429, wait_seconds: 2, retry_count: 1 },
          createdAt: secondsAgo(120),
        },
        // Non-rate-limit action — must be excluded by both query functions.
        {
          workspaceId: workspaceA.id,
          actorType: 'SYSTEM',
          action: 'draft_item.published',
          entityType: 'jira',
          entityId: 'jira',
          metadata: { status_code: 429, wait_seconds: 99, retry_count: 99 },
          createdAt: secondsAgo(30),
        },
      ],
    });
  });

  afterAll(async () => {
    // AuditEvent is trigger-protected (append-only, Issue 8.1); test-database cleanup
    // is the one sanctioned use of the maintenance GUC, and it must share the trigger's
    // session — hence a single transaction.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL specmate.maintenance = 'on'`),
      prisma.auditEvent.deleteMany({
        where: { workspaceId: { in: [workspaceA.id, workspaceB.id] } },
      }),
    ]);
    await prisma.workspace.deleteMany({
      where: { id: { in: [workspaceA.id, workspaceB.id] } },
    });
  });

  describe('getRecentRateLimitIncidents', () => {
    it('returns only connector.rate_limited events, newest first, with parsed metadata', async () => {
      const incidents = await getRecentRateLimitIncidents();
      const scoped = incidents.filter((i) =>
        [workspaceA.id, workspaceB.id].includes(i.workspaceId),
      );

      // The other-action row must not appear.
      expect(scoped.find((i) => i.tool === 'jira' && i.waitSeconds === 99)).toBeUndefined();
      expect(scoped).toHaveLength(4);

      // Newest first.
      const timestamps = scoped.map((i) => i.createdAt.getTime());
      expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));

      const mostRecent = scoped[0];
      expect(mostRecent.tool).toBe('jira');
      expect(mostRecent.workspaceId).toBe(workspaceA.id);
      expect(mostRecent.workspaceName).toBe('Rate Limit Test WS A');
      expect(mostRecent.statusCode).toBe(429);
      expect(mostRecent.waitSeconds).toBe(3);
      expect(mostRecent.retryCount).toBe(2);
    });

    it('respects the limit parameter', async () => {
      const limited = await getRecentRateLimitIncidents(2);
      expect(limited).toHaveLength(2);
    });
  });

  describe('getRateLimitSummary', () => {
    it('groups incidents by (tool, workspace) with correct counts and most-recent timestamp', async () => {
      const summary = await getRateLimitSummary();
      const scoped = summary.filter((s) => [workspaceA.id, workspaceB.id].includes(s.workspaceId));

      const wsAJira = scoped.find((s) => s.tool === 'jira' && s.workspaceId === workspaceA.id);
      expect(wsAJira).toBeDefined();
      expect(wsAJira?.incidentCount).toBe(2);
      expect(wsAJira?.workspaceName).toBe('Rate Limit Test WS A');

      const wsAGithub = scoped.find((s) => s.tool === 'github' && s.workspaceId === workspaceA.id);
      expect(wsAGithub).toBeDefined();
      expect(wsAGithub?.incidentCount).toBe(1);

      const wsBJira = scoped.find((s) => s.tool === 'jira' && s.workspaceId === workspaceB.id);
      expect(wsBJira).toBeDefined();
      expect(wsBJira?.incidentCount).toBe(1);
      expect(wsBJira?.workspaceName).toBe('Rate Limit Test WS B');

      // wsA jira's mostRecentAt should equal the newer of the two grouped rows (secondsAgo(60)).
      expect(
        wsAJira && wsAGithub && wsAJira.mostRecentAt.getTime() > wsAGithub.mostRecentAt.getTime(),
      ).toBe(true);
    });
  });
});
