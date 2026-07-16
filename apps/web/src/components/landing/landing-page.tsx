'use client';

import { useState } from 'react';
import { LandingHero } from './landing-hero';
import { SignInModal } from './sign-in-modal';
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
    runDemo,
    goto,
    setDecisions,
  } = useDemoPlayback();

  const [showSignIn, setShowSignIn] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');

  return (
    <div className="min-h-screen bg-paper text-ink">
      <LandingHero
        playing={playing}
        onRunDemo={runDemo}
        onSignIn={() => {
          setAuthMode('signin');
          setShowSignIn(true);
        }}
      />
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

      {showSignIn ? (
        <SignInModal
          authMode={authMode}
          onModeChange={setAuthMode}
          onClose={() => setShowSignIn(false)}
          onBackHome={() => setShowSignIn(false)}
        />
      ) : null}

      <footer className="border-t border-line bg-panel">
        <div className="mx-auto max-w-[1120px] px-6 py-3">
          <div className="flex flex-wrap justify-between gap-2.5">
            <Mono className="text-sub">INGEST · GENERATE · REVIEW · PUBLISH · AUDIT</Mono>
            <Mono className="text-sub">Jira ◆ Azure DevOps ▲ GitHub ● — cloud + on-prem</Mono>
          </div>
          <div className="mt-3 flex flex-wrap justify-between gap-2.5 border-t border-line pt-3">
            <Mono className="text-sub">© 2026 SpecMate</Mono>
            <div className="flex gap-4.5">
              <a href="#" onClick={(e) => e.preventDefault()} className="no-underline">
                <Mono className="text-sub">Terms &amp; Conditions</Mono>
              </a>
              <a href="#" onClick={(e) => e.preventDefault()} className="no-underline">
                <Mono className="text-sub">Privacy Policy</Mono>
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
