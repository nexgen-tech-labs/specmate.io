import { SOURCES } from './demo-data';
import { Eyebrow, Mono } from './demo-ui';

interface StageIngestProps {
  ingested: number;
  playing: boolean;
}

export function StageIngest({ ingested, playing }: StageIngestProps) {
  return (
    <section className="landing-rise">
      <Eyebrow>SOURCES · CONNECT OR UPLOAD</Eyebrow>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
        {SOURCES.map((s, i) => {
          const done = ingested > i;
          const active = ingested === i && playing;
          return (
            <div
              key={s.name}
              className={`relative overflow-hidden rounded-lg border bg-panel p-5 transition-colors ${
                done ? 'border-cobalt' : 'border-line'
              }`}
            >
              {active ? (
                <div className="landing-scan absolute top-0 left-0 h-0.5 w-2/5 bg-cobalt" />
              ) : null}
              <div className="flex items-start justify-between">
                <span className="text-2xl">{s.icon}</span>
                <Mono className={done ? 'text-green' : 'text-sub'}>
                  {done ? 'PARSED ✓' : active ? 'PARSING…' : 'QUEUED'}
                </Mono>
              </div>
              <div className="mt-3 text-base font-semibold break-all">{s.name}</div>
              <Mono className="mt-2 block text-sub">
                {s.kind} · {s.items}
              </Mono>
            </div>
          );
        })}
      </div>
      <div className="mt-5 flex items-center justify-between rounded-lg border border-line bg-panel p-4">
        <Mono className="text-sub">
          {ingested === 0
            ? 'Press ▶ Run demo — sources parse with page / row / timestamp pointers kept for traceability.'
            : `${ingested}/4 sources parsed · 178 raw requirements extracted · every fragment keeps a source pointer`}
        </Mono>
        {ingested === SOURCES.length ? (
          <Mono className="font-bold text-green">READY → GENERATE</Mono>
        ) : null}
      </div>
    </section>
  );
}
