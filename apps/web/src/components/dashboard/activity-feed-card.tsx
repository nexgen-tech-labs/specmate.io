import type { ActivityFeedItem } from '@/lib/dashboard';

function initials(name: string | null): string {
  if (!name) return 'AI';
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

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

function describeAction(action: string): string {
  // AuditEvent.action is a dotted machine name (e.g. "draft_item.approved") —
  // render a short human phrase without needing a full lookup table for
  // every action this repo logs.
  return action.replace(/_/g, ' ').replace(/\./g, ' ');
}

interface ActivityFeedCardProps {
  activity: ActivityFeedItem[];
}

export function ActivityFeedCard({ activity }: ActivityFeedCardProps) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5.5">
      <div className="mb-4 font-mono text-xs tracking-[0.06em] text-sub">[ ACTIVITY ]</div>
      {activity.length > 0 ? (
        <ul className="flex flex-col gap-3.5">
          {activity.map((item) => (
            <li key={item.id} className="flex gap-2.5">
              <span className="grid size-6 flex-none place-items-center rounded-full bg-[#f0eee6] font-mono text-[10px] font-bold text-sub">
                {initials(item.actorName)}
              </span>
              <div>
                <div className="text-[13px] leading-snug">{describeAction(item.action)}</div>
                <div className="mt-0.5 font-mono text-[11px] text-[#8a919c]">
                  {relativeTime(item.createdAt)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] leading-relaxed text-[#8a919c]">
          Ingests, approvals, and publishes from everyone in this workspace.
        </p>
      )}
    </section>
  );
}
