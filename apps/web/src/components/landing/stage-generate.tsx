import { GEN_ITEMS } from './demo-data';
import { Eyebrow, Mono, Score, TypeBadge } from './demo-ui';

interface StageGenerateProps {
  genCount: number;
}

export function StageGenerate({ genCount }: StageGenerateProps) {
  return (
    <section className="landing-rise">
      <div className="flex items-baseline justify-between">
        <Eyebrow>AI DRAFT · EPICS / STORIES / AC / RISKS / NFRS / TESTS</Eyebrow>
        <Mono className="text-sub">
          {genCount}/{GEN_ITEMS.length} drafted
        </Mono>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="grid grid-cols-[100px_1fr_150px_140px] border-b border-line bg-[#FCFBF8] px-4 py-2.5">
          {['TYPE', 'ITEM', 'QUALITY', 'SOURCE'].map((h) => (
            <Mono key={h} className="text-sub">
              {h}
            </Mono>
          ))}
        </div>
        {GEN_ITEMS.slice(0, genCount).map((it) => (
          <div
            key={it.id}
            className="landing-rise grid grid-cols-[100px_1fr_150px_140px] items-center gap-2 border-b border-line px-4 py-3"
          >
            <div>
              <TypeBadge type={it.type} />
            </div>
            <div className="text-base">
              {it.title}
              <div className="mt-1.5 flex flex-wrap gap-2">
                {it.ac ? <Mono className="text-sub">{it.ac} acceptance criteria</Mono> : null}
                {it.parent ? <Mono className="text-sub">↳ {it.parent}</Mono> : null}
                {it.flag === 'dup' ? (
                  <Mono className="rounded-[3px] bg-red-soft px-1.5 py-px text-red">
                    possible duplicate · PAY-118
                  </Mono>
                ) : null}
                {it.flag === 'gap' ? (
                  <Mono className="rounded-[3px] bg-amber-soft px-1.5 py-px text-amber">
                    missing info detected
                  </Mono>
                ) : null}
              </div>
            </div>
            <Score value={it.score} />
            <Mono className="text-sub">{it.src}</Mono>
          </div>
        ))}
        {genCount < GEN_ITEMS.length ? (
          <div className="px-4 py-3.5">
            <Mono className="landing-pulse text-cobalt">▋ drafting next item…</Mono>
          </div>
        ) : null}
      </div>
    </section>
  );
}
