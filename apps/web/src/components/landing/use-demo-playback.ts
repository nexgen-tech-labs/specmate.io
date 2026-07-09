import { useCallback, useEffect, useRef, useState } from 'react';
import { GEN_ITEMS, SOURCES } from './demo-data';

export type Decision = 'approved' | 'rejected' | 'edited';

const REVIEW_SEQUENCE: [string, Decision][] = [
  ['E-1', 'approved'],
  ['S-1', 'approved'],
  ['S-2', 'approved'],
  ['S-3', 'edited'],
  ['R-1', 'approved'],
  ['Q-1', 'approved'],
  ['S-4', 'rejected'],
  ['N-1', 'approved'],
  ['T-1', 'approved'],
];

export function useDemoPlayback() {
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ingested, setIngested] = useState(0);
  const [genCount, setGenCount] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [published, setPublished] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const reset = useCallback(() => {
    clearTimers();
    setStage(0);
    setPlaying(false);
    setIngested(0);
    setGenCount(0);
    setDecisions({});
    setPublished(0);
  }, []);

  const runDemo = useCallback(() => {
    reset();
    setPlaying(true);

    SOURCES.forEach((_, i) => later(() => setIngested(i + 1), 500 + i * 550));
    later(() => setStage(1), 500 + SOURCES.length * 550 + 500);

    const genStart = 500 + SOURCES.length * 550 + 1100;
    GEN_ITEMS.forEach((_, i) => later(() => setGenCount(i + 1), genStart + i * 420));
    const revStart = genStart + GEN_ITEMS.length * 420 + 700;
    later(() => setStage(2), revStart);

    REVIEW_SEQUENCE.forEach(([id, decision], i) =>
      later(() => setDecisions((prev) => ({ ...prev, [id]: decision })), revStart + 600 + i * 480),
    );
    const pubStart = revStart + 600 + REVIEW_SEQUENCE.length * 480 + 800;
    later(() => setStage(3), pubStart);

    for (let i = 1; i <= 7; i++) later(() => setPublished(i), pubStart + 500 + i * 380);
    later(() => setStage(4), pubStart + 500 + 8 * 380 + 700);
    later(() => setPlaying(false), pubStart + 500 + 8 * 380 + 800);
  }, [reset]);

  useEffect(() => () => clearTimers(), []);

  const goto = useCallback(
    (i: number) => {
      if (playing) return;
      setStage(i);
      setIngested(i >= 1 ? SOURCES.length : 0);
      setGenCount(i >= 2 ? GEN_ITEMS.length : 0);
      setDecisions(
        i >= 2
          ? Object.fromEntries(
              GEN_ITEMS.map((g) => [
                g.id,
                g.id === 'S-4' ? 'rejected' : g.id === 'S-3' ? 'edited' : 'approved',
              ]),
            )
          : {},
      );
      setPublished(i >= 4 ? 7 : 0);
    },
    [playing],
  );

  const approvedCount = Object.values(decisions).filter(
    (d) => d === 'approved' || d === 'edited',
  ).length;
  const rejectedCount = Object.values(decisions).filter((d) => d === 'rejected').length;

  return {
    stage,
    playing,
    ingested,
    genCount,
    decisions,
    published,
    approvedCount,
    rejectedCount,
    reset,
    runDemo,
    goto,
    setDecisions,
  };
}
