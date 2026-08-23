export interface StepperStep {
  key: string;
  label: string;
}

interface StepperProps {
  steps: StepperStep[];
  currentKey: string;
  /** Optional: mark a step "done" (green check) instead of pending — defaults to every step before the current one. */
  isDone?: (index: number) => boolean;
  /** Shows a pulsing dot next to the active step's label (e.g. while a demo/process is actively running it). */
  active?: boolean;
  onSelect?: (index: number) => void;
}

export function Stepper({ steps, currentKey, isDone, active = false, onSelect }: StepperProps) {
  const currentIndex = steps.findIndex((s) => s.key === currentKey);

  return (
    <div className="flex border-t border-b border-line">
      {steps.map((s, i) => {
        const isCurrent = i === currentIndex;
        const done = isDone ? isDone(i) : currentIndex > i;
        const Tag = onSelect ? 'button' : 'div';
        return (
          <Tag
            key={s.key}
            onClick={onSelect ? () => onSelect(i) : undefined}
            className={`flex-1 border-b-2 px-4 pt-4 pb-3.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cobalt ${
              i < steps.length - 1 ? 'border-r border-r-line' : ''
            } ${isCurrent ? 'border-b-cobalt bg-panel' : 'border-b-transparent bg-transparent'}`}
          >
            <span
              className={`font-mono text-sm tracking-[0.06em] ${
                done ? 'text-green' : isCurrent ? 'text-cobalt' : 'text-sub'
              }`}
            >
              STEP {String(i + 1).padStart(2, '0')}{' '}
              {done ? '✓' : isCurrent && active ? <span className="landing-pulse">●</span> : ''}
            </span>
            <div
              className={`mt-1.5 text-base font-semibold ${isCurrent ? 'text-ink' : 'text-sub'}`}
            >
              {s.label}
            </div>
          </Tag>
        );
      })}
    </div>
  );
}
