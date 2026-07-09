import { GEN_ITEMS, TARGETS } from './demo-data';
import { Eyebrow, Mono } from './demo-ui';

interface StagePublishProps {
  published: number;
}

const PUBLISHABLE_ITEMS = GEN_ITEMS.filter(
  (g) => g.id !== 'S-4' && ['EPIC', 'STORY', 'NFR'].includes(g.type),
);

export function StagePublish({ published }: StagePublishProps) {
  return (
    <section className="landing-rise">
      <Eyebrow>CONNECTOR PUBLISH · FIELD-MAPPED PER TOOL</Eyebrow>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
        {TARGETS.map((t) => (
          <div key={t.key} className="overflow-hidden rounded-lg border border-line bg-panel">
            <div className="flex items-center justify-between border-b border-line bg-[#FCFBF8] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-cobalt">{t.glyph}</span>
                <span className="text-base font-bold">{t.name}</span>
              </div>
              <Mono className="text-sub">{t.note}</Mono>
            </div>
            <div className="min-h-[168px] px-4 py-2.5">
              {PUBLISHABLE_ITEMS.slice(0, Math.min(published, 5)).map((g, i) => (
                <div
                  key={g.id}
                  className="landing-rise flex justify-between border-b border-dashed border-line py-1.5"
                >
                  <Mono className="text-ink">
                    {g.id} · {g.type.toLowerCase()}
                  </Mono>
                  <Mono className="font-bold text-green">{t.keyFmt(i + 1)} ✓</Mono>
                </div>
              ))}
              {published === 0 ? (
                <Mono className="text-sub">waiting for approved items…</Mono>
              ) : null}
              {published > 0 && published < 7 ? (
                <Mono className="landing-pulse block pt-2 text-cobalt">▋ creating via API…</Mono>
              ) : null}
            </div>
            <div className="border-t border-line px-4 py-2.5">
              <Mono className="text-sub">
                issue type · status · custom fields mapped ✓ · external key written back for trace
              </Mono>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
