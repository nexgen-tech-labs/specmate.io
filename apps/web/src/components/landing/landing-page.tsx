'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LandingHero } from './landing-hero';
import { StageAudit } from './stage-audit';
import { StageGenerate } from './stage-generate';
import { StageIngest } from './stage-ingest';
import { StagePublish } from './stage-publish';
import { StageReview } from './stage-review';
import { StageStepper } from './stage-stepper';
import { Mono } from './demo-ui';
import { useDemoPlayback } from './use-demo-playback';

export function LandingPage(props: { remainingInvites: number | null; totalInvites: number }) {
  return (
    <Suspense fallback={null}>
      <LandingPageInner {...props} />
    </Suspense>
  );
}

function LandingPageInner({
  remainingInvites,
  totalInvites,
}: {
  remainingInvites: number | null;
  totalInvites: number;
}) {
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

  // Deep-linkable so "Get Started"/"Get started" elsewhere in the app
  // (site-wide header, the Sign In modal) can send visitors straight into
  // this flow via ?request-access=1 rather than the dead-ended /onboarding
  // page while self-serve signup is disabled (invite-only beta). A
  // same-route router.push (e.g. from the Sign In modal, already mounted on
  // "/") updates useSearchParams() without remounting this component, so a
  // one-time lazy-initial-state read would miss it. "Storing information
  // from previous renders" (React's documented pattern, plain useState —
  // NOT a ref, since mutating a ref during render is separately disallowed)
  // — updates both the modal's open state and the last-seen param together,
  // during render, whenever the param changes.
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestAccessParam = searchParams.get('request-access');
  const [showRequestAccess, setShowRequestAccess] = useState(false);
  const [lastSeenParam, setLastSeenParam] = useState<string | null>(null);
  if (requestAccessParam === '1' && lastSeenParam !== requestAccessParam) {
    setLastSeenParam(requestAccessParam);
    setShowRequestAccess(true);
  }
  // Strip only request-access once consumed, so a later refresh doesn't
  // reopen the modal — leaves any utm_* params in the URL untouched (read
  // below, once, at mount) since a visitor arriving via a marketing link
  // with BOTH ?utm_source=...&request-access=1 should still get attributed
  // if they submit the form after this fires. Pure navigation, not
  // setState, so it belongs in an effect.
  useEffect(() => {
    if (requestAccessParam === '1') {
      const params = new URLSearchParams(window.location.search);
      params.delete('request-access');
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : '/');
    }
  }, [requestAccessParam, router]);

  // First-touch UTM attribution (Issue 10.1's "analytics correctly attribute
  // signups to traffic source" AC) — captured once at mount, not re-read on
  // every render, so it reflects the link that actually brought this visitor
  // in rather than whatever's in the URL at submit time.
  const [utmParams] = useState(() => ({
    utmSource: searchParams.get('utm_source'),
    utmMedium: searchParams.get('utm_medium'),
    utmCampaign: searchParams.get('utm_campaign'),
  }));

  return (
    <div className="min-h-screen bg-paper text-ink">
      <LandingHero
        playing={playing}
        onRunDemo={runDemo}
        remainingInvites={remainingInvites}
        totalInvites={totalInvites}
        showRequestAccess={showRequestAccess}
        onShowRequestAccess={() => setShowRequestAccess(true)}
        onCloseRequestAccess={() => setShowRequestAccess(false)}
        utmParams={utmParams}
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
