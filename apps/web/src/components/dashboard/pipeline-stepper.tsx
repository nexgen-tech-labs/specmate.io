import { Stepper } from '@/components/layout/stepper';
import type { PipelineSummary } from '@/lib/dashboard';

interface PipelineStepperProps {
  pipeline: PipelineSummary;
}

// Live-data 5-stage pipeline bar (Onboarding Flow redesign) — thin wrapper
// around the shared Stepper's "pipeline" variant, which renders each step's
// {count, unit} meta as a large number plus a footer band.
export function PipelineStepper({ pipeline }: PipelineStepperProps) {
  return (
    <Stepper
      variant="pipeline"
      steps={pipeline.stages.map((stage) => ({
        key: stage.key,
        label: stage.label,
        meta: { count: stage.count, unit: stage.unit },
      }))}
      currentKey={pipeline.activeKey}
      footer="WORKSPACE TOTALS · LIVE"
    />
  );
}
