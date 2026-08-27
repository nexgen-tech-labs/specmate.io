'use client';

import { useRouter } from 'next/navigation';
import { SourcesCard } from './sources-card';
import { IntegrationsCard } from './integrations-card';
import type { IntegrationSummary, SourceSummaryItem } from '@/lib/dashboard';

// Thin client wrappers around the presentation-only cards, since navigating
// on click needs useRouter. Placeholder navigation to existing project-scoped
// pages for now — PR 5 swaps these for real modals opened in-place.

export function SourcesCardWithNav({
  recent,
  addSourceHref,
}: {
  recent: SourceSummaryItem[];
  addSourceHref: string;
}) {
  const router = useRouter();
  return <SourcesCard recent={recent} onAddSource={() => router.push(addSourceHref)} />;
}

export function IntegrationsCardWithNav({
  integrations,
  connectHref,
}: {
  integrations: IntegrationSummary[];
  connectHref: string;
}) {
  const router = useRouter();
  return <IntegrationsCard integrations={integrations} onManage={() => router.push(connectHref)} />;
}
