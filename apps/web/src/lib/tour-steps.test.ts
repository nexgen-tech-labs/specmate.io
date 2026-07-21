import { describe, expect, it } from 'vitest';
import { TOUR_STEPS, getStepById, getNextStep } from './tour-steps';

describe('tour-steps', () => {
  it('has a non-empty ordered list of steps with unique ids', () => {
    expect(TOUR_STEPS.length).toBeGreaterThan(0);
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getStepById finds a step by id', () => {
    const first = TOUR_STEPS[0];
    expect(getStepById(first.id)).toEqual(first);
  });

  it('getStepById returns undefined for an unknown id', () => {
    expect(getStepById('not-a-real-step')).toBeUndefined();
  });

  it('getNextStep returns the following step in order', () => {
    const first = TOUR_STEPS[0];
    const second = TOUR_STEPS[1];
    expect(getNextStep(first.id)).toEqual(second);
  });

  it('getNextStep returns undefined after the last step', () => {
    const last = TOUR_STEPS[TOUR_STEPS.length - 1];
    expect(getNextStep(last.id)).toBeUndefined();
  });
});
