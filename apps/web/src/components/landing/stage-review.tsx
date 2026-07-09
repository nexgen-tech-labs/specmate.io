import { GEN_ITEMS } from './demo-data';
import type { Decision } from './use-demo-playback';
import { Eyebrow, Mono, TypeBadge } from './demo-ui';

interface StageReviewProps {
  decisions: Record<string, Decision>;
  playing: boolean;
  approvedCount: number;
  rejectedCount: number;
  onDecide: (id: string, decision: Decision) => void;
}

const BORDER_CLASS: Record<Decision | 'pending', string> = {
  approved: 'border-green',
  rejected: 'border-red',
  edited: 'border-amber',
  pending: 'border-line',
};

const STATUS_TEXT_CLASS: Record<Decision, string> = {
  approved: 'text-green',
  rejected: 'text-red',
  edited: 'text-amber',
};

export function StageReview({
  decisions,
  playing,
  approvedCount,
  rejectedCount,
  onDecide,
}: StageReviewProps) {
  return (
    <section className="landing-rise">
      <div className="flex items-baseline justify-between">
        <Eyebrow>HUMAN-IN-THE-LOOP · NOTHING PUBLISHES WITHOUT APPROVAL</Eyebrow>
        <Mono className="text-sub">
          {approvedCount} approved · {rejectedCount} rejected
        </Mono>
      </div>
      <div className="grid gap-2">
        {GEN_ITEMS.map((it) => {
          const d = decisions[it.id];
          const borderClass = BORDER_CLASS[d ?? 'pending'];
          return (
            <div
              key={it.id}
              className={`flex items-center gap-4 rounded-lg border border-l-[3px] bg-panel px-5 py-4 transition-colors ${borderClass} ${
                d === 'rejected' ? 'opacity-55' : 'opacity-100'
              }`}
            >
              <TypeBadge type={it.type} />
              <div className={`flex-1 text-base ${d === 'rejected' ? 'line-through' : ''}`}>
                {it.title}
                {d === 'edited' ? (
                  <Mono className="ml-2 text-amber">
                    · edited by priya.n — AC added for ERP version
                  </Mono>
                ) : null}
                {d === 'rejected' ? (
                  <Mono className="ml-2 text-red">· duplicate of PAY-118</Mono>
                ) : null}
              </div>
              {!d && !playing ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => onDecide(it.id, 'approved')}
                    className="rounded-md bg-green-soft px-3.5 py-2 font-mono text-sm font-bold text-green focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => onDecide(it.id, 'rejected')}
                    className="rounded-md bg-red-soft px-3.5 py-2 font-mono text-sm font-bold text-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
                  >
                    Reject
                  </button>
                </div>
              ) : null}
              {d ? (
                <Mono className={`font-bold ${STATUS_TEXT_CLASS[d]}`}>
                  {d === 'approved'
                    ? 'APPROVED ✓'
                    : d === 'edited'
                      ? 'EDITED + APPROVED ✓'
                      : 'REJECTED ✕'}
                </Mono>
              ) : null}
              {!d && playing ? <Mono className="text-sub">awaiting review…</Mono> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
