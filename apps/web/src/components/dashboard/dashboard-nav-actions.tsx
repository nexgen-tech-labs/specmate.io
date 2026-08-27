'use client';

import { SourcesCard } from './sources-card';
import { IntegrationsCard } from './integrations-card';
import type { IntegrationSummary, SourceSummaryItem } from '@/lib/dashboard';

// Thin client wrappers around the presentation-only cards — PR 5 swaps their
// former placeholder navigation for real modals opened in-place via
// DashboardClientShell's lifted activeModal state.

export function SourcesCardWithNav({
  recent,
  onAddSource,
}: {
  recent: SourceSummaryItem[];
  onAddSource: () => void;
}) {
  return <SourcesCard recent={recent} onAddSource={onAddSource} />;
}

export function IntegrationsCardWithNav({
  integrations,
  onManage,
}: {
  integrations: IntegrationSummary[];
  onManage: () => void;
}) {
  return <IntegrationsCard integrations={integrations} onManage={onManage} />;
}
