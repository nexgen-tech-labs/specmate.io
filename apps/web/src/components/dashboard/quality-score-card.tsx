import type { QualityScoreSummary } from '@/lib/dashboard';

const BAND_COLOR: Record<QualityScoreSummary['bands'][number]['color'], string> = {
  green: 'bg-green',
  amber: 'bg-amber',
  red: 'bg-red',
};

interface QualityScoreCardProps {
  summary: QualityScoreSummary;
}

export function QualityScoreCard({ summary }: QualityScoreCardProps) {
  const hasData = summary.scoredCount > 0;
  const maxBand = Math.max(1, ...summary.bands.map((b) => b.count));

  return (
    <section className="rounded-xl border border-line bg-panel p-5.5">
      <div className="mb-4 font-mono text-xs tracking-[0.06em] text-sub">[ QUALITY SCORE ]</div>
      {hasData ? (
        <div>
          <div className="mb-3.5 flex items-baseline gap-2">
            <span className="font-mono text-[38px] leading-none font-bold tracking-tight text-green">
              {summary.average}
            </span>
            <span className="text-[13px] text-sub">avg across {summary.scoredCount} items</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {summary.bands.map((band) => (
              <div key={band.label}>
                <div className="mb-1.5 flex justify-between font-mono text-[11px] text-sub">
                  <span>{band.label}</span>
                  <span>{band.count}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[#f0eee6]">
                  <div
                    className={`h-full ${BAND_COLOR[band.color]}`}
                    style={{ width: `${Math.round((band.count / maxBand) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[13px] leading-relaxed text-[#8a919c]">
          Every drafted item gets scored on clarity, testability, and traceability. The spread shows
          up here.
        </p>
      )}
    </section>
  );
}
