'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
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
import { AddSourceModal } from '@/components/dashboard/add-source-modal';
import { ConnectToolModal } from '@/components/dashboard/connect-tool-modal';
import { InviteModal } from '@/components/dashboard/invite-modal';
import type { ChecklistItem } from '@/components/dashboard/onboarding-checklist';
import type {
  ActivityFeedItem,
  AwaitingReviewSummary,
  IntegrationSummary,
  PipelineSummary,
  PublishedBatch,
  QualityScoreSummary,
  SourceSummaryItem,
} from '@/lib/dashboard';
import type { UsageSummary } from '@/lib/usage';

type ActiveModal = 'source' | 'connect' | 'invite' | null;

// Owns the 3 modals' open/closed state (Add Source, Connect a Tool, Invite) —
// centralized here rather than threading callbacks through every card, since
// multiple triggers (checklist tiles, header buttons, per-card actions) open
// the same modals. Also the client boundary the OAuth-return redirect
// (?connect_tool=X&oauth=success from /organizations/[id]/connect/[toolKey])
// lands on, to reopen the Connect modal at its scope step.
export function DashboardClientShell({
  workspaceId,
  organizationId,
  canCreate,
  isAdmin,
  billingHref,
  reviewHref,
  pipeline,
  sources,
  review,
  published,
  quality,
  activity,
  integrations,
  usage,
  checklistItems,
  dismissedInitially,
  defaultProjectId,
}: {
  workspaceId: string;
  organizationId: string | null;
  canCreate: boolean;
  isAdmin: boolean;
  billingHref: string;
  reviewHref: string | null;
  pipeline: PipelineSummary;
  sources: { total: number; recent: SourceSummaryItem[] };
  review: AwaitingReviewSummary;
  published: PublishedBatch[];
  quality: QualityScoreSummary;
  activity: ActivityFeedItem[];
  integrations: IntegrationSummary[];
  usage: UsageSummary;
  checklistItems: ChecklistItem[];
  dismissedInitially: boolean;
  defaultProjectId: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTool = searchParams.get('connect_tool');
  const [activeModal, setActiveModal] = useState<ActiveModal>(returnTool ? 'connect' : null);
  const [connectInitialTool, setConnectInitialTool] = useState<string | undefined>(
    returnTool ?? undefined,
  );

  useEffect(() => {
    // Strip the OAuth-return query params from the URL once consumed above,
    // so a refresh doesn't reopen the modal — state (not the URL) now owns
    // "which modal is open."
    if (returnTool) router.replace(`/workspaces/${workspaceId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeModal() {
    setActiveModal(null);
    setConnectInitialTool(undefined);
  }

  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-6">
        <div className="flex items-center gap-2.5">
          {canCreate ? <TakeTourButton /> : null}
          {canCreate ? (
            <>
              <button
                type="button"
                onClick={() => setActiveModal('connect')}
                className="rounded-md border border-line bg-panel px-4.5 py-3 text-sm font-semibold text-ink"
              >
                Connect a tool
              </button>
              <button
                type="button"
                onClick={() => setActiveModal('source')}
                className="rounded-md bg-cobalt px-5 py-3 text-sm font-bold text-white"
              >
                + Add source
              </button>
            </>
          ) : null}
          {isAdmin ? (
            <Link
              href={billingHref}
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
          dismissedInitially={dismissedInitially}
          onSelectConnectTool={() => setActiveModal('connect')}
          onSelectAddSource={() => setActiveModal('source')}
          onSelectInvite={() => setActiveModal('invite')}
        />
      ) : null}

      <PipelineStepper
        pipeline={pipeline}
        workspaceId={workspaceId}
        defaultProjectId={defaultProjectId}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.55fr_1fr] lg:items-start">
        <div className="flex flex-col gap-5">
          <SourcesCardWithNav
            workspaceId={workspaceId}
            recent={sources.recent}
            onAddSource={() => setActiveModal('source')}
          />
          <AwaitingReviewCard summary={review} reviewHref={reviewHref} />
          <RecentlyPublishedCard batches={published} />
        </div>
        <div className="flex flex-col gap-5">
          <IntegrationsCardWithNav
            integrations={integrations}
            onManage={() => setActiveModal('connect')}
          />
          <QualityScoreCard summary={quality} />
          <ActivityFeedCard activity={activity} />
          <UsageCard usage={usage} />
        </div>
      </div>

      {activeModal === 'source' && defaultProjectId ? (
        <AddSourceModal
          workspaceId={workspaceId}
          projectId={defaultProjectId}
          onClose={closeModal}
        />
      ) : null}
      {activeModal === 'connect' && organizationId ? (
        <ConnectToolModal
          organizationId={organizationId}
          workspaceId={workspaceId}
          initialToolKey={connectInitialTool}
          defaultProjectId={defaultProjectId}
          onClose={closeModal}
        />
      ) : null}
      {activeModal === 'invite' ? (
        <InviteModal workspaceId={workspaceId} onClose={closeModal} />
      ) : null}
    </>
  );
}
