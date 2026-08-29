export interface StepperStep {
  key: string;
  label: string;
  /** Optional per-step metadata rendered under the label — a short string in
   * the default "compact" variant, or a {count, unit} pair rendered as a
   * large number in the "pipeline" variant (see PipelineStepper). */
  meta?: string | { count: number; unit: string };
  /** Optional per-step CTA rendered under the meta — pipeline variant only
   * (e.g. "Generate" on the AI-generation stage). Its own click handler, so
   * it works independently of the card's onSelect (which would otherwise
   * fire too, since the CTA sits inside the same clickable card). */
  action?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
    loadingLabel?: string;
  };
}

interface StepperProps {
  steps: StepperStep[];
  currentKey: string;
  /** Optional: mark a step "done" (green check) instead of pending — defaults to every step before the current one. */
  isDone?: (index: number) => boolean;
  /** Shows a pulsing dot next to the active step's label (e.g. while a demo/process is actively running it). */
  active?: boolean;
  onSelect?: (index: number) => void;
  /** "compact" (default): wizard/demo style, thin bottom-border indicator.
   * "pipeline": bigger cards with a bottom accent bar, sized for a `{count,
   * unit}` meta pair — used by the dashboard's live pipeline bar. */
  variant?: 'compact' | 'pipeline';
  /** Rendered as a footer band below the steps — pipeline variant only. */
  footer?: React.ReactNode;
}

export function Stepper({
  steps,
  currentKey,
  isDone,
  active = false,
  onSelect,
  variant = 'compact',
  footer,
}: StepperProps) {
  const currentIndex = steps.findIndex((s) => s.key === currentKey);

  if (variant === 'pipeline') {
    return (
      <div className="mb-7 overflow-hidden rounded-xl border border-line bg-panel">
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
        >
          {steps.map((s, i) => {
            const isCurrent = i === currentIndex;
            // A step with its own action button can't also be a <button>
            // itself (nested buttons are invalid HTML / a hydration error) —
            // fall back to a plain clickable div in that case.
            const Tag = onSelect && !s.action ? 'button' : 'div';
            const meta = typeof s.meta === 'object' ? s.meta : undefined;
            return (
              <Tag
                key={s.key}
                onClick={onSelect && !s.action ? () => onSelect(i) : undefined}
                className={`border-r border-b-[3px] border-line px-5.5 py-5 text-left last:border-r-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cobalt ${
                  isCurrent ? 'border-b-cobalt bg-panel' : 'border-b-transparent bg-paper'
                }`}
              >
                <div
                  className={`mb-2 font-mono text-xs tracking-[0.06em] ${
                    isCurrent ? 'text-cobalt' : 'text-sub'
                  }`}
                >
                  STEP {String(i + 1).padStart(2, '0')}
                </div>
                <div className="mb-2.5 text-sm font-bold tracking-tight text-ink">{s.label}</div>
                {meta ? (
                  <div className="flex items-baseline gap-1.5">
                    <span
                      className={`font-mono text-2xl font-bold ${meta.count > 0 ? 'text-ink' : 'text-line'}`}
                    >
                      {meta.count}
                    </span>
                    <span className="text-xs text-sub">{meta.unit}</span>
                  </div>
                ) : null}
                {s.action ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      s.action?.onClick();
                    }}
                    disabled={s.action.disabled || s.action.loading}
                    className="mt-3 rounded-md bg-cobalt px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                  >
                    {s.action.loading ? (s.action.loadingLabel ?? 'Working…') : s.action.label}
                  </button>
                ) : null}
              </Tag>
            );
          })}
        </div>
        {footer ? (
          <div className="border-t border-line bg-paper px-5.5 py-2.5 font-mono text-[11px] text-sub">
            {footer}
          </div>
        ) : null}
      </div>
    );
  }

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
            {typeof s.meta === 'string' ? (
              <div className="mt-1 text-xs text-sub">{s.meta}</div>
            ) : null}
          </Tag>
        );
      })}
    </div>
  );
}
