import Link from 'next/link';
import { Eyebrow } from './demo-ui';

interface LandingHeroProps {
  playing: boolean;
  onRunDemo: () => void;
}

export function LandingHero({ playing, onRunDemo }: LandingHeroProps) {
  return (
    <div className="mx-auto max-w-[1120px] px-6 pt-16 pb-4">
      <Eyebrow>DELIVERY SPEC LAYER</Eyebrow>
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
        <Link
          href="/onboarding"
          className="inline-block rounded-md bg-cobalt px-7 py-3.5 text-lg font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
        >
          Get Started →
        </Link>
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
    </div>
  );
}
