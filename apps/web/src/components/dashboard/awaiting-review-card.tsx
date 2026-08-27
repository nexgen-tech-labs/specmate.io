import Link from 'next/link';
import type { AwaitingReviewSummary } from '@/lib/dashboard';

interface AwaitingReviewCardProps {
  summary: AwaitingReviewSummary;
  reviewHref: string | null;
}

export function AwaitingReviewCard({ summary, reviewHref }: AwaitingReviewCardProps) {
  const hasItems = summary.total > 0;

  return (
    <section
      className={`rounded-xl border p-6 ${hasItems ? 'border-line bg-panel' : 'border-[#eeece4] bg-[#fdfdfa]'}`}
    >
      <div className="mb-4 font-mono text-xs tracking-[0.06em] text-sub">
        [ AWAITING YOUR REVIEW ]
      </div>
      {hasItems ? (
        <div className="flex items-end justify-between gap-5">
          <div>
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-[44px] leading-none font-bold tracking-tight text-ink">
                {summary.total}
              </span>
              <span className="text-sm text-sub">items drafted, none published yet</span>
            </div>
            <div className="mt-3.5 flex gap-4">
              {summary.breakdown.map((b) => (
                <span key={b.type} className="font-mono text-xs text-sub">
                  {b.count} {b.type.toLowerCase()}
                  {b.count === 1 ? '' : 's'}
                </span>
              ))}
            </div>
          </div>
          {reviewHref ? (
            <Link
              href={reviewHref}
              className="rounded-md bg-ink px-5 py-3.5 text-sm font-bold whitespace-nowrap text-white"
            >
              Start review →
            </Link>
          ) : null}
        </div>
      ) : (
        <p className="text-sm leading-relaxed text-[#8a919c]">
          Drafted items land here for approval. Nothing reaches Jira, ADO, or GitHub until you sign
          off.
        </p>
      )}
    </section>
  );
}
