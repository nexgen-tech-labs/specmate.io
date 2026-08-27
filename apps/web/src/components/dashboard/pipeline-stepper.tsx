import type { PipelineSummary } from '@/lib/dashboard';

interface PipelineStepperProps {
  pipeline: PipelineSummary;
}

// Live-data 5-stage pipeline bar (Onboarding Flow redesign) — visually
// modeled on the landing page's StageStepper, but each stage shows a real
// count + unit label pulled from getPipelineCounts. The shared layout/
// Stepper component doesn't support per-step metadata yet (that's PR 6's
// job); this is a standalone implementation for now, swapped to reuse
// Stepper once its `meta` prop lands.
export function PipelineStepper({ pipeline }: PipelineStepperProps) {
  const activeIndex = pipeline.stages.findIndex((s) => s.key === pipeline.activeKey);

  return (
    <div className="mb-7 overflow-hidden rounded-xl border border-line bg-panel">
      <div className="grid grid-cols-5">
        {pipeline.stages.map((stage, i) => {
          const isActive = i === activeIndex;
          return (
            <div
              key={stage.key}
              className={`border-r border-b-[3px] border-line px-5.5 py-5 text-left last:border-r-0 ${
                isActive ? 'border-b-cobalt bg-panel' : 'border-b-transparent bg-paper'
              }`}
            >
              <div
                className={`mb-2 font-mono text-xs tracking-[0.06em] ${
                  isActive ? 'text-cobalt' : 'text-sub'
                }`}
              >
                STEP {String(i + 1).padStart(2, '0')}
              </div>
              <div className="mb-2.5 text-sm font-bold tracking-tight text-ink">{stage.label}</div>
              <div className="flex items-baseline gap-1.5">
                <span
                  className={`font-mono text-2xl font-bold ${stage.count > 0 ? 'text-ink' : 'text-line'}`}
                >
                  {stage.count}
                </span>
                <span className="text-xs text-sub">{stage.unit}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-line bg-paper px-5.5 py-2.5 font-mono text-[11px] text-sub">
        WORKSPACE TOTALS · LIVE
      </div>
    </div>
  );
}
