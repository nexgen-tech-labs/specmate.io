import type { ReactNode } from 'react';
import { TYPE_STYLE, type ItemType } from './demo-data';

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-sm tracking-[0.06em] ${className}`}>{children}</span>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 font-mono text-sm font-medium tracking-[0.1em] text-sub">
      [ {children} ]
    </div>
  );
}

export function TypeBadge({ type }: { type: ItemType }) {
  const s = TYPE_STYLE[type] ?? TYPE_STYLE.STORY;
  return (
    <span
      className={`rounded-[4px] px-2.5 py-1 font-mono text-xs font-semibold tracking-[0.04em] ${s.bg} ${s.fg}`}
    >
      {type}
    </span>
  );
}

export function Score({ value }: { value: number | null }) {
  if (value == null) return <Mono className="text-sub">—</Mono>;
  const colorClass = value >= 85 ? 'bg-green' : value >= 75 ? 'bg-amber' : 'bg-red';
  const textClass = value >= 85 ? 'text-green' : value >= 75 ? 'text-amber' : 'text-red';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-11 overflow-hidden rounded-sm bg-[#EEECE5]">
        <div
          className={`h-full ${colorClass} transition-[width] duration-500 ease-out`}
          style={{ width: `${value}%` }}
        />
      </div>
      <Mono className={`font-semibold ${textClass}`}>{value}</Mono>
    </div>
  );
}
