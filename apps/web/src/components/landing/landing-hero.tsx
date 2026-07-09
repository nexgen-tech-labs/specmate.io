import Link from 'next/link';
import { Eyebrow, Mono } from './demo-ui';

interface LandingHeroProps {
  playing: boolean;
  onReset: () => void;
  onRunDemo: () => void;
}

export function LandingHero({ playing, onReset, onRunDemo }: LandingHeroProps) {
  return (
    <>
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-[1120px] items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid size-8 place-items-center rounded bg-cobalt font-mono text-sm font-bold text-white">
              S
            </div>
            <span className="text-lg font-bold tracking-tight">SpecMate</span>
            <Mono className="ml-2 text-sm text-sub">demo · mocked data</Mono>
          </div>
          <div className="flex gap-3">
            <button
              onClick={onReset}
              disabled={playing}
              className={`rounded-md border border-line bg-transparent px-4 py-2.5 font-mono text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt ${
                playing ? 'text-line' : 'text-ink'
              }`}
            >
              Reset
            </button>
            <button
              onClick={onRunDemo}
              disabled={playing}
              className={`rounded-md border-none px-5 py-2.5 font-mono text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt ${
                playing ? 'bg-[#9AA6E8]' : 'bg-cobalt'
              }`}
            >
              {playing ? 'Running…' : '▶ Run end-to-end demo'}
            </button>
            <Link
              href="/onboarding"
              className="rounded-md bg-ink px-5 py-2.5 font-mono text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

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
        <Link
          href="/onboarding"
          className="mt-8 inline-block rounded-md bg-cobalt px-7 py-3.5 text-lg font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
        >
          Get Started →
        </Link>
      </div>
    </>
  );
}
