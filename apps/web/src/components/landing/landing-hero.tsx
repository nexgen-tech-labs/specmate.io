'use client';

import { useState } from 'react';
import { Eyebrow } from './demo-ui';
import { RequestAccessModal } from './request-access-modal';

interface LandingHeroProps {
  playing: boolean;
  onRunDemo: () => void;
  remainingInvites: number | null;
  totalInvites: number;
}

export function LandingHero({
  playing,
  onRunDemo,
  remainingInvites,
  totalInvites,
}: LandingHeroProps) {
  const [showRequestAccess, setShowRequestAccess] = useState(false);

  return (
    <div className="mx-auto max-w-[1120px] px-6 pt-16 pb-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Eyebrow>DELIVERY SPEC LAYER</Eyebrow>
        {remainingInvites !== null ? (
          <span className="rounded-full border border-cobalt px-3 py-1 font-mono text-xs font-semibold tracking-[0.06em] text-cobalt">
            {remainingInvites} of {totalInvites} invites left
          </span>
        ) : null}
      </div>
      <h1 className="m-0 text-6xl leading-[1.05] font-bold tracking-tight sm:text-7xl">
        Messy requirements in.
        <br />
        <span className="text-cobalt">Approved work items out.</span>
      </h1>
      <p className="mt-6 max-w-2xl text-xl leading-relaxed text-sub">
        Every item is AI-drafted, quality-scored, traced to its source, human-approved — then
        published to Jira, Azure DevOps, or GitHub. Nothing ships without sign-off.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setShowRequestAccess(true)}
          className="inline-block rounded-md bg-cobalt px-7 py-3.5 text-lg font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
        >
          Request access →
        </button>
        <button
          onClick={onRunDemo}
          disabled={playing}
          className={`rounded-md border-none px-7 py-3.5 font-mono text-lg font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt ${
            playing ? 'bg-[#9AA6E8]' : 'bg-ink'
          }`}
        >
          {playing ? 'Running…' : '▶ Run end-to-end demo'}
        </button>
      </div>
      {showRequestAccess ? (
        <RequestAccessModal onClose={() => setShowRequestAccess(false)} />
      ) : null}
    </div>
  );
}
