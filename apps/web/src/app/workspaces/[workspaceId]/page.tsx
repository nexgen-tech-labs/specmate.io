import { notFound } from 'next/navigation';
import { getAccessibleProjectIds, requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { getWorkspaceUsageSummary } from '@/lib/usage';
import {
  getActivityFeed,
  getAwaitingReviewSummary,
  getIntegrationsSummary,
  getOrCreateDefaultProjectId,
  getPipelineCounts,
  getQualityScoreSummary,
  getRecentlyPublishedBatches,
  getSourcesSummary,
} from '@/lib/dashboard';
import { orgSizeLabel } from '@/lib/org-size';
import { DashboardClientShell } from '@/components/dashboard/dashboard-client-shell';
import type { ChecklistItem } from '@/components/dashboard/onboarding-checklist';

// Workspace dashboard (Onboarding Flow redesign) — replaces the flat
// project-list page. Everything below is workspace-wide (aggregated across
// every accessible project via getAccessibleProjectIds), matching the
// design's mockup, which has no notion of a project list at all.
export default async function WorkspaceDashboardPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) notFound();

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: { organization: { select: { id: true, name: true, size: true } } },
  });
  if (!workspace) notFound();

  const orgBreadcrumb = workspace.organization
    ? [workspace.organization.name, orgSizeLabel(workspace.organization.size)]
        .filter(Boolean)
        .join(' / ')
    : null;

  const accessibleProjectIds = await getAccessibleProjectIds(workspaceId, access.membership);

  const [pipeline, sources, review, published, quality, activity, integrations, usage] =
    await Promise.all([
      getPipelineCounts(workspaceId, accessibleProjectIds),
      getSourcesSummary(workspaceId, accessibleProjectIds),
      getAwaitingReviewSummary(workspaceId, accessibleProjectIds),
      getRecentlyPublishedBatches(workspaceId, accessibleProjectIds),
      getQualityScoreSummary(workspaceId, accessibleProjectIds),
      getActivityFeed(workspaceId),
      getIntegrationsSummary(workspace.organizationId, workspaceId),
      getWorkspaceUsageSummary(workspaceId),
    ]);

  // Resolving (or lazily creating) a default project only when actually
  // needed avoids writing to the DB on every dashboard view — the Add Source
  // modal needs a projectId to post sources against (Source has no
  // workspace-level home in the schema).
  const canCreate = access.membership.role !== 'VIEWER';
  const defaultProjectId = canCreate
    ? await getOrCreateDefaultProjectId(workspaceId, workspace.name)
    : null;
  const reviewHref = defaultProjectId
    ? `/workspaces/${workspaceId}/projects/${defaultProjectId}/review`
    : null;

  const anyConnected = integrations.some((i) => i.connected);
  const invitesSent = false; // no cheap existing-invite check yet; refined if the Invite modal needs a "done" signal later
  const checklistItems: ChecklistItem[] = [
    {
      key: 'tool',
      title: 'Connect a tool',
      body: 'Authorize Jira, ADO, or GitHub once at the org.',
      done: anyConnected,
    },
    {
      key: 'source',
      title: 'Add your first source',
      body: 'A doc, a transcript, or an existing backlog.',
      done: sources.total > 0,
    },
    {
      key: 'invite',
      title: 'Invite your team',
      body: 'Reviewers approve items before they publish.',
      done: invitesSent,
    },
  ];

  const subtitle =
    sources.total > 0
      ? `${sources.total} source${sources.total === 1 ? '' : 's'} · ${pipeline.stages.find((s) => s.key === 'generation')?.count ?? 0} items drafted`
      : 'No sources yet — everything below fills in as work flows through';

  return (
    <div className="min-h-screen bg-paper px-6 py-10">
      <div className="mx-auto max-w-[1120px]">
        <div className="mb-6">
          {orgBreadcrumb ? (
            <div className="mb-1.5 font-mono text-xs text-sub">{orgBreadcrumb}</div>
          ) : null}
          <h1 className="text-[34px] font-extrabold tracking-tight text-ink">{workspace.name}</h1>
          <p className="mt-2 text-[15px] text-sub">{subtitle}</p>
        </div>

        <DashboardClientShell
          workspaceId={workspaceId}
          organizationId={workspace.organizationId}
          canCreate={canCreate}
          isAdmin={access.membership.role === 'ADMIN'}
          billingHref={`/workspaces/${workspaceId}/billing`}
          reviewHref={reviewHref}
          pipeline={pipeline}
          sources={sources}
          review={review}
          published={published}
          quality={quality}
          activity={activity}
          integrations={integrations}
          usage={usage}
          checklistItems={checklistItems}
          dismissedInitially={workspace.onboardingChecklistDismissedAt !== null}
          defaultProjectId={defaultProjectId}
        />
      </div>
    </div>
  );
}
