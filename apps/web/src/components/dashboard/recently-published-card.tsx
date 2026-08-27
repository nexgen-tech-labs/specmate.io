import type { PublishedBatch } from '@/lib/dashboard';

const TOOL_LABEL: Record<string, string> = {
  JIRA: 'Jira',
  ADO: 'Azure DevOps',
  GITHUB: 'GitHub',
};

function relativeTime(when: Date): string {
  const diffMs = Date.now() - when.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

interface RecentlyPublishedCardProps {
  batches: PublishedBatch[];
}

export function RecentlyPublishedCard({ batches }: RecentlyPublishedCardProps) {
  return (
    <section
      className={`rounded-xl border p-6 ${batches.length > 0 ? 'border-line bg-panel' : 'border-[#eeece4] bg-[#fdfdfa]'}`}
    >
      <div className="mb-4 font-mono text-xs tracking-[0.06em] text-sub">
        [ RECENTLY PUBLISHED ]
      </div>
      {batches.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {batches.map((batch, i) => (
            <li
              key={`${batch.targetTool}-${batch.when.getTime()}`}
              className={`flex items-center justify-between gap-4 ${
                i < batches.length - 1 ? 'border-b border-[#f0eee6] pb-3' : ''
              }`}
            >
              <div>
                <div className="text-sm font-semibold text-ink">
                  {batch.count} item{batch.count === 1 ? '' : 's'} published
                </div>
                <div className="mt-0.5 font-mono text-xs text-[#8a919c]">
                  {TOOL_LABEL[batch.targetTool] ?? batch.targetTool} · {relativeTime(batch.when)}
                </div>
              </div>
              <span className="font-mono text-xs whitespace-nowrap text-green">
                ✓ {batch.count} items
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm leading-relaxed text-[#8a919c]">
          Approved batches appear here with a link straight to the board they landed on.
        </p>
      )}
    </section>
  );
}
