import { STAGES } from './demo-data';
import { Mono } from './demo-ui';

interface StageStepperProps {
  stage: number;
  playing: boolean;
  onSelect: (index: number) => void;
}

export function StageStepper({ stage, playing, onSelect }: StageStepperProps) {
  return (
    <div className="mx-auto max-w-[1120px] px-6 pt-8">
      <div className="flex border-t border-b border-line">
        {STAGES.map((s, i) => {
          const active = stage === i;
          const done = stage > i;
          return (
            <button
              key={s.key}
              onClick={() => onSelect(i)}
              className={`flex-1 border-b-2 px-4 pt-4 pb-3.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cobalt ${
                i < STAGES.length - 1 ? 'border-r border-r-line' : ''
              } ${active ? 'border-b-cobalt bg-panel' : 'border-b-transparent bg-transparent'}`}
            >
              <Mono className={done ? 'text-green' : active ? 'text-cobalt' : 'text-sub'}>
                STEP 0{i + 1}{' '}
                {done ? '✓' : active && playing ? <span className="landing-pulse">●</span> : ''}
              </Mono>
              <div className={`mt-1.5 text-base font-semibold ${active ? 'text-ink' : 'text-sub'}`}>
                {s.label}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
