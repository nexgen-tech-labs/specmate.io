import type { UsageSummary } from '@/lib/usage';

interface UsageCardProps {
  usage: UsageSummary;
}

export function UsageCard({ usage }: UsageCardProps) {
  const label =
    usage.includedItems === null
      ? `${usage.publishedItemCount} ITEMS`
      : `${usage.publishedItemCount} / ${usage.includedItems} ITEMS`;
  const note =
    usage.remaining === null
      ? 'Unlimited on your plan.'
      : `${usage.remaining} item${usage.remaining === 1 ? '' : 's'} left in your trial.`;
  const widthPct = usage.percentUsed === null ? 2 : Math.max(2, Math.min(100, usage.percentUsed));

  return (
    <section className="rounded-xl border border-line bg-panel p-5.5">
      <div className="mb-3.5 flex items-center justify-between">
        <div className="font-mono text-xs tracking-[0.06em] text-sub">[ PLAN · {usage.tier} ]</div>
        <span className="font-mono text-[11px] text-[#8a919c]">{label}</span>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-[#f0eee6]">
        <div className="h-full bg-cobalt" style={{ width: `${widthPct}%` }} />
      </div>
      <div className="text-[13px] text-sub">{note}</div>
    </section>
  );
}
