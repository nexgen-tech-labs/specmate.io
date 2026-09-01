'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Stepper, type StepperStep } from '@/components/layout/stepper';
import type { PipelineSummary } from '@/lib/dashboard';

interface PipelineStepperProps {
  pipeline: PipelineSummary;
  workspaceId: string;
  /** Project generation runs against — resolved the same way the dashboard's
   * other actions resolve one (getOrCreateDefaultProjectId). Null for a
   * VIEWER, who has no generate action here (same gate as Add source/Connect). */
  defaultProjectId: string | null;
  /** Set when the project's latest GenerationRun is still EPICS_PENDING_REVIEW
   * — a returning user's Generate click should jump straight to review (their
   * actual next step) instead of re-triggering generate_epics on an
   * already-pending run (harmless/idempotent, but a wasted round trip). */
  pendingGenerationRunId?: string | null;
}

// Maps each pipeline stage to the real page it's backed by — there's no
// dedicated page for "AI generation" alone (action-only, via the Generate
// button) or "Publish to tools" alone (publishing happens inline on the
// Review page, alongside approve/reject), so both land on the nearest real
// page rather than going nowhere.
const STAGE_PAGE: Record<string, string> = {
  ingest: 'sources',
  generation: 'sources',
  review: 'review',
  publish: 'review',
  audit: 'audit',
};

// Live-data 5-stage pipeline bar (Onboarding Flow redesign) — thin wrapper
// around the shared Stepper's "pipeline" variant, which renders each step's
// {count, unit} meta as a large number plus a footer band. Owns the
// "AI generation" stage's Generate action — the only way to trigger
// generation from the redesigned dashboard (the old /get-started wizard's
// generate step is no longer linked from here) — and per-step navigation to
// the underlying project page, since the pipeline bar itself has no other
// way to move between stages.
export function PipelineStepper({
  pipeline,
  workspaceId,
  defaultProjectId,
  pendingGenerationRunId,
}: PipelineStepperProps) {
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceCount = pipeline.stages.find((s) => s.key === 'ingest')?.count ?? 0;
  const reviewHref = defaultProjectId
    ? `/workspaces/${workspaceId}/projects/${defaultProjectId}/review`
    : null;

  async function handleGenerate() {
    if (!defaultProjectId) return;
    // A run is already sitting in EPICS_PENDING_REVIEW for this project —
    // nothing new to generate, the reviewer's next step is to go approve
    // epics, not re-trigger an idempotent-but-wasted round trip.
    if (pendingGenerationRunId && reviewHref) {
      router.push(reviewHref);
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/projects/${defaultProjectId}/generate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        setError(body.detail ?? body.error ?? 'Generation failed — try again.');
        return;
      }
      const payload = (await res.json()) as { stage?: string };
      if (payload.stage === 'EPICS_PENDING_REVIEW' && reviewHref) {
        router.push(reviewHref);
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the generation service — try again.');
    } finally {
      setGenerating(false);
    }
  }

  const steps: StepperStep[] = pipeline.stages.map((stage) => ({
    key: stage.key,
    label: stage.label,
    meta: { count: stage.count, unit: stage.unit },
    action:
      stage.key === 'generation' && defaultProjectId && sourceCount > 0
        ? {
            label: 'Generate',
            onClick: () => void handleGenerate(),
            loading: generating,
            loadingLabel: 'Generating…',
          }
        : undefined,
  }));

  return (
    <div>
      <Stepper
        variant="pipeline"
        steps={steps}
        currentKey={pipeline.activeKey}
        footer="WORKSPACE TOTALS · LIVE"
        onSelect={
          defaultProjectId
            ? (index) => {
                const page = STAGE_PAGE[pipeline.stages[index].key];
                if (page) {
                  router.push(`/workspaces/${workspaceId}/projects/${defaultProjectId}/${page}`);
                }
              }
            : undefined
        }
      />
      {error ? <p className="-mt-5 mb-5 text-sm text-red">{error}</p> : null}
    </div>
  );
}
