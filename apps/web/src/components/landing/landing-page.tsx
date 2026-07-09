'use client';

import { LandingHero } from './landing-hero';
import { StageAudit } from './stage-audit';
import { StageGenerate } from './stage-generate';
import { StageIngest } from './stage-ingest';
import { StagePublish } from './stage-publish';
import { StageReview } from './stage-review';
import { StageStepper } from './stage-stepper';
import { Mono } from './demo-ui';
import { useDemoPlayback } from './use-demo-playback';

export function LandingPage() {
  const {
    stage,
    playing,
    ingested,
    genCount,
    decisions,
    published,
    approvedCount,
    rejectedCount,
    reset,
    runDemo,
    goto,
    setDecisions,
  } = useDemoPlayback();

  return (
    <div className="min-h-screen bg-paper text-ink">
      <LandingHero playing={playing} onReset={reset} onRunDemo={runDemo} />
      <StageStepper stage={stage} playing={playing} onSelect={goto} />

      <main className="mx-auto max-w-[1120px] px-6 pt-6.5 pb-15">
        {stage === 0 ? <StageIngest ingested={ingested} playing={playing} /> : null}
        {stage === 1 ? <StageGenerate genCount={genCount} /> : null}
        {stage === 2 ? (
          <StageReview
            decisions={decisions}
            playing={playing}
            approvedCount={approvedCount}
            rejectedCount={rejectedCount}
            onDecide={(id, decision) => setDecisions((prev) => ({ ...prev, [id]: decision }))}
          />
        ) : null}
        {stage === 3 ? <StagePublish published={published} /> : null}
        {stage === 4 ? <StageAudit /> : null}
      </main>

      <footer className="border-t border-line bg-panel">
        <div className="mx-auto flex max-w-[1120px] justify-between px-6 py-3">
          <Mono className="text-sub">INGEST · GENERATE · REVIEW · PUBLISH · AUDIT</Mono>
          <Mono className="text-sub">Jira ◆ Azure DevOps ▲ GitHub ● — cloud + on-prem</Mono>
        </div>
      </footer>
    </div>
  );
}
