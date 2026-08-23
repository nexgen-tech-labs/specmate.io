import { Stepper } from '@/components/layout/stepper';
import { STAGES } from './demo-data';

interface StageStepperProps {
  stage: number;
  playing: boolean;
  onSelect: (index: number) => void;
}

export function StageStepper({ stage, playing, onSelect }: StageStepperProps) {
  return (
    <div className="mx-auto max-w-[1120px] px-6 pt-8">
      <Stepper
        steps={STAGES.map((s) => ({ key: s.key, label: s.label }))}
        currentKey={STAGES[stage].key}
        active={playing}
        onSelect={onSelect}
      />
    </div>
  );
}
