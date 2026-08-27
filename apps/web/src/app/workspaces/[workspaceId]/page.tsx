import Link from 'next/link';
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
import { TakeTourButton } from '@/components/tour/take-tour-button';
import { PipelineStepper } from '@/components/dashboard/pipeline-stepper';
import { DashboardChecklistSection } from '@/components/dashboard/dashboard-checklist-section';
import {
  SourcesCardWithNav,
  IntegrationsCardWithNav,
} from '@/components/dashboard/dashboard-nav-actions';
import { AwaitingReviewCard } from '@/components/dashboard/awaiting-review-card';
import { RecentlyPublishedCard } from '@/components/dashboard/recently-published-card';
import { QualityScoreCard } from '@/components/dashboard/quality-score-card';
import { ActivityFeedCard } from '@/components/dashboard/activity-feed-card';
import { UsageCard } from '@/components/dashboard/usage-card';
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

  // Placeholder targets until PR 5 adds real modals — the checklist tiles and
  // header buttons route into the existing project-scoped pages. Resolving
  // (or lazily creating) a default project only when actually needed avoids
  // writing to the DB on every dashboard view.
  const canCreate = access.membership.role !== 'VIEWER';
  const defaultProjectId = canCreate
    ? await getOrCreateDefaultProjectId(workspaceId, workspace.name)
    : null;
  const addSourceHref = defaultProjectId
    ? `/workspaces/${workspaceId}/projects/${defaultProjectId}/sources`
    : `/workspaces/${workspaceId}`;
  const connectHref = defaultProjectId
    ? `/workspaces/${workspaceId}/projects/${defaultProjectId}/get-started`
    : `/workspaces/${workspaceId}`;
  const reviewHref = defaultProjectId
    ? `/workspaces/${workspaceId}/projects/${defaultProjectId}/review`
    : null;
  const inviteHref = `/workspaces/${workspaceId}/invite`;

  const anyConnected = integrations.some((i) => i.connected);
  const invitesSent = false; // no cheap existing-invite check yet; refined once the Invite modal (PR 5) lands
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
        <div className="mb-6 flex items-end justify-between gap-6">
          <div>
            {orgBreadcrumb ? (
              <div className="mb-1.5 font-mono text-xs text-sub">{orgBreadcrumb}</div>
            ) : null}
            <h1 className="text-[34px] font-extrabold tracking-tight text-ink">{workspace.name}</h1>
            <p className="mt-2 text-[15px] text-sub">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2.5">
            {canCreate ? <TakeTourButton /> : null}
            {canCreate ? (
              <>
                <Link
                  href={connectHref}
                  className="rounded-md border border-line bg-panel px-4.5 py-3 text-sm font-semibold text-ink"
                >
                  Connect a tool
                </Link>
                <Link
                  href={addSourceHref}
                  className="rounded-md bg-cobalt px-5 py-3 text-sm font-bold text-white"
                >
                  + Add source
                </Link>
              </>
            ) : null}
            {access.membership.role === 'ADMIN' ? (
              <Link
                href={`/workspaces/${workspaceId}/billing`}
                className="text-sm text-cobalt underline-offset-2 hover:underline"
              >
                Billing →
              </Link>
            ) : null}
          </div>
        </div>

        {canCreate ? (
          <DashboardChecklistSection
            workspaceId={workspaceId}
            items={checklistItems}
            dismissedInitially={workspace.onboardingChecklistDismissedAt !== null}
            connectHref={connectHref}
            addSourceHref={addSourceHref}
            inviteHref={inviteHref}
          />
        ) : null}

        <PipelineStepper pipeline={pipeline} />

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.55fr_1fr] lg:items-start">
          <div className="flex flex-col gap-5">
            <SourcesCardWithNav recent={sources.recent} addSourceHref={addSourceHref} />
            <AwaitingReviewCard summary={review} reviewHref={reviewHref} />
            <RecentlyPublishedCard batches={published} />
          </div>
          <div className="flex flex-col gap-5">
            <IntegrationsCardWithNav integrations={integrations} connectHref={connectHref} />
            <QualityScoreCard summary={quality} />
            <ActivityFeedCard activity={activity} />
            <UsageCard usage={usage} />
          </div>
        </div>
      </div>
    </div>
  );
}
