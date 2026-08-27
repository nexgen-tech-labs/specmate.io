'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SourcesCard } from './sources-card';
import { IntegrationsCard } from './integrations-card';
import type { IntegrationSummary, SourceSummaryItem } from '@/lib/dashboard';

// Thin client wrappers around the presentation-only cards — PR 5 swaps their
// former placeholder navigation for real modals opened in-place via
// DashboardClientShell's lifted activeModal state.

export function SourcesCardWithNav({
  workspaceId,
  recent,
  onAddSource,
}: {
  workspaceId: string;
  recent: SourceSummaryItem[];
  onAddSource: () => void;
}) {
  const router = useRouter();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRemove(source: SourceSummaryItem) {
    if (!window.confirm(`Remove "${source.name}"? Its extracted content stops being used.`)) {
      return;
    }
    setRemovingId(source.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/projects/${source.projectId}/sources/${source.id}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not remove the source — try again.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the server — try again.');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div>
      {error ? <p className="mb-2 text-sm text-red">{error}</p> : null}
      <SourcesCard
        recent={recent}
        onAddSource={onAddSource}
        onRemoveSource={(source) => void handleRemove(source)}
        removingId={removingId}
      />
    </div>
  );
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
