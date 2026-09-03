/**
 * Workspace dashboard aggregation (Onboarding Flow redesign) — Source/
 * DraftItem/PublishedItem have no direct workspaceId column, only
 * projectId with Project.workspaceId as the only path to a workspace
 * (confirmed: `usage.ts`'s getWorkspaceUsageSummary already has to do this
 * exact 3-hop nested-where join). Every function here takes an
 * already-computed `accessibleProjectIds` (from getAccessibleProjectIds) so a
 * team-scoped member never sees aggregate counts leaking from projects
 * outside their team — computed once by the page, not re-derived per call.
 */
import { prisma } from './prisma';

type ProjectScope = Set<string> | null;

function projectWhere(workspaceId: string, accessibleProjectIds: ProjectScope) {
  return {
    workspaceId,
    deletedAt: null,
    ...(accessibleProjectIds ? { id: { in: [...accessibleProjectIds] } } : {}),
  };
}

export interface PipelineStageCount {
  key: 'ingest' | 'generation' | 'review' | 'publish' | 'audit';
  label: string;
  count: number;
  unit: string;
}

const PIPELINE_LABELS: Record<PipelineStageCount['key'], string> = {
  ingest: 'Ingest sources',
  generation: 'AI generation',
  review: 'Human review',
  publish: 'Publish to tools',
  audit: 'Audit & sync',
};

export interface PipelineSummary {
  stages: PipelineStageCount[];
  activeKey: PipelineStageCount['key'];
}

export async function getPipelineCounts(
  workspaceId: string,
  accessibleProjectIds: ProjectScope,
): Promise<PipelineSummary> {
  const projectFilter = { project: projectWhere(workspaceId, accessibleProjectIds) };

  const [sourceCount, draftedCount, pendingCount, publishedCount] = await Promise.all([
    prisma.source.count({ where: { deletedAt: null, ...projectFilter } }),
    prisma.draftItem.count({ where: { deletedAt: null, ...projectFilter } }),
    prisma.draftItem.count({ where: { deletedAt: null, status: 'PENDING', ...projectFilter } }),
    prisma.publishedItem.count({ where: { deletedAt: null, draftItem: projectFilter } }),
  ]);

  const counts: Record<PipelineStageCount['key'], number> = {
    ingest: sourceCount,
    generation: draftedCount,
    review: pendingCount,
    publish: publishedCount,
    audit: publishedCount,
  };
  const units: Record<PipelineStageCount['key'], string> = {
    ingest: sourceCount === 1 ? 'source' : 'sources',
    generation: 'drafted',
    review: 'to approve',
    publish: publishedCount === 1 ? 'item live' : 'items live',
    audit: 'in sync',
  };

  // Active stage: the furthest-along stage with real data, since that's
  // where the user's attention naturally is right now.
  let activeKey: PipelineStageCount['key'] = 'ingest';
  if (sourceCount > 0) activeKey = 'ingest';
  if (draftedCount > 0) activeKey = 'generation';
  if (pendingCount > 0) activeKey = 'review';
  if (publishedCount > 0) activeKey = 'publish';

  const order: PipelineStageCount['key'][] = ['ingest', 'generation', 'review', 'publish', 'audit'];
  return {
    stages: order.map((key) => ({
      key,
      label: PIPELINE_LABELS[key],
      count: counts[key],
      unit: units[key],
    })),
    activeKey,
  };
}

export interface SourceSummaryItem {
  id: string;
  name: string;
  kind: string;
  status: string;
  createdAt: Date;
  // Needed client-side to build the DELETE .../sources/[sourceId] URL — the
  // dashboard aggregates sources across every accessible project, so unlike
  // the project-scoped sources page, projectId isn't implicit from the route.
  projectId: string;
  // Set once this source's fragments have been sent to a generate_epics pass.
  isGenerated: boolean;
}

export async function getSourcesSummary(
  workspaceId: string,
  accessibleProjectIds: ProjectScope,
  take = 6,
): Promise<{ total: number; recent: SourceSummaryItem[] }> {
  const where = { project: projectWhere(workspaceId, accessibleProjectIds) };
  const [total, recent] = await Promise.all([
    prisma.source.count({ where: { deletedAt: null, ...where } }),
    prisma.source.findMany({
      where: { deletedAt: null, ...where },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        name: true,
        kind: true,
        status: true,
        createdAt: true,
        projectId: true,
        generatedInRunId: true,
      },
    }),
  ]);
  return {
    total,
    recent: recent.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      status: s.status,
      createdAt: s.createdAt,
      projectId: s.projectId,
      isGenerated: s.generatedInRunId !== null,
    })),
  };
}

export interface AwaitingReviewSummary {
  total: number;
  breakdown: Array<{ type: string; count: number }>;
}

export async function getAwaitingReviewSummary(
  workspaceId: string,
  accessibleProjectIds: ProjectScope,
): Promise<AwaitingReviewSummary> {
  const where = {
    deletedAt: null,
    status: 'PENDING' as const,
    project: projectWhere(workspaceId, accessibleProjectIds),
  };
  const grouped = await prisma.draftItem.groupBy({
    by: ['type'],
    where,
    _count: true,
  });
  const total = grouped.reduce((sum, g) => sum + g._count, 0);
  return {
    total,
    breakdown: grouped
      .map((g) => ({ type: g.type, count: g._count }))
      .sort((a, b) => b.count - a.count),
  };
}

export interface PublishedBatch {
  targetTool: string;
  when: Date;
  count: number;
}

export async function getRecentlyPublishedBatches(
  workspaceId: string,
  accessibleProjectIds: ProjectScope,
  take = 5,
): Promise<PublishedBatch[]> {
  const rows = await prisma.publishedItem.findMany({
    where: {
      deletedAt: null,
      draftItem: { project: projectWhere(workspaceId, accessibleProjectIds) },
    },
    orderBy: { createdAt: 'desc' },
    take: 200, // enough rows to form a handful of recent batches; bucketed below
    select: { targetTool: true, createdAt: true },
  });

  // No PublishBatch model exists — group query-side by (targetTool, 5-minute
  // bucket) as a cheap approximation of "one publish run", good enough for a
  // dashboard summary card. A real batch concept is a schema follow-up if
  // exact boundaries ever matter (e.g. partial-failure UI).
  const BUCKET_MS = 5 * 60 * 1000;
  const buckets = new Map<string, PublishedBatch>();
  for (const row of rows) {
    const bucketTime = Math.floor(row.createdAt.getTime() / BUCKET_MS) * BUCKET_MS;
    const key = `${row.targetTool}:${bucketTime}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      if (row.createdAt > existing.when) existing.when = row.createdAt;
    } else {
      buckets.set(key, { targetTool: row.targetTool, when: row.createdAt, count: 1 });
    }
  }
  return [...buckets.values()].sort((a, b) => b.when.getTime() - a.when.getTime()).slice(0, take);
}

export interface QualityScoreSummary {
  average: number | null;
  bands: Array<{ label: string; count: number; color: 'green' | 'amber' | 'red' }>;
  scoredCount: number;
}

export async function getQualityScoreSummary(
  workspaceId: string,
  accessibleProjectIds: ProjectScope,
): Promise<QualityScoreSummary> {
  const where = {
    deletedAt: null,
    qualityScore: { not: null },
    project: projectWhere(workspaceId, accessibleProjectIds),
  };
  const [agg, ready, needsDetail, missingCriteria] = await Promise.all([
    prisma.draftItem.aggregate({ where, _avg: { qualityScore: true }, _count: true }),
    prisma.draftItem.count({ where: { ...where, qualityScore: { gte: 85 } } }),
    prisma.draftItem.count({ where: { ...where, qualityScore: { gte: 75, lt: 85 } } }),
    prisma.draftItem.count({ where: { ...where, qualityScore: { lt: 75 } } }),
  ]);

  return {
    average: agg._avg.qualityScore === null ? null : Math.round(agg._avg.qualityScore),
    scoredCount: agg._count,
    bands: [
      { label: 'Ready to publish', count: ready, color: 'green' },
      { label: 'Needs detail', count: needsDetail, color: 'amber' },
      { label: 'Missing criteria', count: missingCriteria, color: 'red' },
    ],
  };
}

export interface ActivityFeedItem {
  id: string;
  action: string;
  createdAt: Date;
  actorName: string | null;
}

export async function getActivityFeed(workspaceId: string, take = 8): Promise<ActivityFeedItem[]> {
  // AuditEvent already has a direct workspaceId column (designed
  // workspace-first, unlike Source/DraftItem/PublishedItem) — no project-hop
  // join needed here, matching review/activity/page.tsx's query shape minus
  // its project-scoping filter.
  const events = await prisma.auditEvent.findMany({
    where: { workspaceId },
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take,
  });
  return events.map((e) => ({
    id: e.id,
    action: e.action,
    createdAt: e.createdAt,
    actorName: e.actor?.name ?? null,
  }));
}

/**
 * The new dashboard treats Sources/Review/Publish as workspace-level
 * concepts, but the schema requires a Project underneath (Source.projectId —
 * no Source.workspaceId shortcut). For a workspace with exactly one project,
 * use it; with zero, create a default one lazily on first use; with more
 * than one (pre-redesign workspaces), fall back to the most recently active
 * one rather than picking arbitrarily.
 */
export async function getOrCreateDefaultProjectId(
  workspaceId: string,
  workspaceName: string,
): Promise<string> {
  const existing = await prisma.project.findFirst({
    where: { workspaceId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.project.create({
    data: { workspaceId, name: workspaceName },
    select: { id: true },
  });
  return created.id;
}

/** The project's latest GenerationRun id if it's still EPICS_PENDING_REVIEW —
 * lets the dashboard's Generate button navigate a returning user straight to
 * review instead of re-triggering generate_epics on an already-pending run.
 * Null once the run is COMPLETE (or none exists yet). */
export async function getPendingGenerationRunId(projectId: string): Promise<string | null> {
  const run = await prisma.generationRun.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, stage: true },
  });
  return run?.stage === 'EPICS_PENDING_REVIEW' ? run.id : null;
}

export interface IntegrationSummary {
  toolKey: string;
  connected: boolean;
  scopeLabel: string | null;
}

const KNOWN_TOOLS = ['jira', 'ado', 'github'] as const;

export async function getIntegrationsSummary(
  organizationId: string | null,
  workspaceId: string,
): Promise<IntegrationSummary[]> {
  if (!organizationId) {
    return KNOWN_TOOLS.map((toolKey) => ({ toolKey, connected: false, scopeLabel: null }));
  }

  const [connections, scopes] = await Promise.all([
    prisma.connection.findMany({
      where: { organizationId },
      select: { id: true, toolKey: true },
    }),
    prisma.workspaceConnectionScope.findMany({
      where: { workspaceId },
      select: { connectionId: true, scopeLabel: true },
    }),
  ]);
  const scopeByConnectionId = new Map(scopes.map((s) => [s.connectionId, s.scopeLabel]));

  return KNOWN_TOOLS.map((toolKey) => {
    const connection = connections.find((c) => c.toolKey === toolKey);
    return {
      toolKey,
      connected: !!connection,
      scopeLabel: connection ? (scopeByConnectionId.get(connection.id) ?? null) : null,
    };
  });
}
