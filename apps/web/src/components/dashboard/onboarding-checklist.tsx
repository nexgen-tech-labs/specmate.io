'use client';

import { useState } from 'react';

export interface ChecklistItem {
  key: 'tool' | 'source' | 'invite';
  title: string;
  body: string;
  done: boolean;
}

interface OnboardingChecklistProps {
  items: ChecklistItem[];
  dismissedInitially: boolean;
  onDismiss: () => void;
  onSelect: (key: ChecklistItem['key']) => void;
}

// Dismissible "Set up your workspace" checklist (Onboarding Flow redesign).
// Completion state is always server-derived (passed in via `items`);
// dismissal is the only client-owned bit, persisted server-side by the
// caller's onDismiss (Workspace.onboardingChecklistDismissedAt) so it's
// consistent across devices/teammates rather than a localStorage flag.
export function OnboardingChecklist({
  items,
  dismissedInitially,
  onDismiss,
  onSelect,
}: OnboardingChecklistProps) {
  const [dismissed, setDismissed] = useState(dismissedInitially);
  const doneCount = items.filter((i) => i.done).length;

  if (dismissed || doneCount === items.length) return null;

  return (
    <div className="mb-7 rounded-xl border border-[#d5dcfb] bg-[#f4f6ff] p-6.5">
      <div className="mb-1 flex items-center justify-between">
        <div className="font-mono text-xs tracking-[0.06em] text-cobalt">
          [ SET UP YOUR WORKSPACE · {doneCount} OF {items.length} ]
        </div>
        <button
          type="button"
          onClick={() => {
            setDismissed(true);
            onDismiss();
          }}
          className="border-none bg-transparent font-mono text-xs text-sub"
        >
          Dismiss
        </button>
      </div>
      <p className="mb-5 text-sm text-sub">
        Nothing here blocks you. Add a source and SpecMate starts drafting immediately.
      </p>
      <div className="grid grid-cols-3 gap-3">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onSelect(item.key)}
            className={`rounded-[10px] border p-4.5 text-left ${
              item.done ? 'border-line bg-paper' : 'border-[#d5dcfb] bg-white'
            }`}
          >
            <div className="mb-2 flex items-center gap-2.5">
              <span
                className={`grid size-5 place-items-center rounded-full text-[11px] font-bold text-white ${
                  item.done ? 'bg-green' : 'bg-[#dfe4fd]'
                }`}
              >
                {item.done ? '✓' : ''}
              </span>
              <span className={`text-sm font-bold ${item.done ? 'text-sub' : 'text-ink'}`}>
                {item.title}
              </span>
            </div>
            <div className="text-[13px] leading-relaxed text-sub">{item.body}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
