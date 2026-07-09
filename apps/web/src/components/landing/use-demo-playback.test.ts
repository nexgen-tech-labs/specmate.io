import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDemoPlayback } from './use-demo-playback';

describe('useDemoPlayback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at stage 0 with everything reset', () => {
    const { result } = renderHook(() => useDemoPlayback());
    expect(result.current.stage).toBe(0);
    expect(result.current.playing).toBe(false);
    expect(result.current.ingested).toBe(0);
    expect(result.current.genCount).toBe(0);
    expect(result.current.published).toBe(0);
    expect(result.current.decisions).toEqual({});
  });

  it('goto jumps directly to a stage with consistent derived state', () => {
    const { result } = renderHook(() => useDemoPlayback());

    act(() => result.current.goto(2));
    expect(result.current.stage).toBe(2);
    expect(result.current.ingested).toBe(4);
    expect(result.current.genCount).toBe(9);
    expect(result.current.decisions['S-4']).toBe('rejected');
    expect(result.current.decisions['S-3']).toBe('edited');
    expect(result.current.decisions['E-1']).toBe('approved');
    expect(result.current.published).toBe(0);

    act(() => result.current.goto(4));
    expect(result.current.published).toBe(7);

    act(() => result.current.goto(0));
    expect(result.current.ingested).toBe(0);
    expect(result.current.genCount).toBe(0);
    expect(result.current.decisions).toEqual({});
    expect(result.current.published).toBe(0);
  });

  it('goto is a no-op while playing', () => {
    const { result } = renderHook(() => useDemoPlayback());

    act(() => result.current.runDemo());
    expect(result.current.playing).toBe(true);

    act(() => result.current.goto(4));
    expect(result.current.stage).toBe(0);
  });

  it('runDemo progresses through all five stages over time', () => {
    const { result } = renderHook(() => useDemoPlayback());

    act(() => result.current.runDemo());
    expect(result.current.playing).toBe(true);
    expect(result.current.stage).toBe(0);

    act(() => vi.runAllTimers());

    expect(result.current.stage).toBe(4);
    expect(result.current.playing).toBe(false);
    expect(result.current.ingested).toBe(4);
    expect(result.current.genCount).toBe(9);
    expect(result.current.published).toBe(7);
    expect(result.current.approvedCount).toBe(8);
    expect(result.current.rejectedCount).toBe(1);
  });

  it('reset clears all state and pending timers', () => {
    const { result } = renderHook(() => useDemoPlayback());

    act(() => result.current.runDemo());
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.reset());

    expect(result.current.stage).toBe(0);
    expect(result.current.playing).toBe(false);
    expect(result.current.ingested).toBe(0);

    // advancing timers further should not resurrect the old run
    act(() => vi.runAllTimers());
    expect(result.current.stage).toBe(0);
    expect(result.current.playing).toBe(false);
  });
});
