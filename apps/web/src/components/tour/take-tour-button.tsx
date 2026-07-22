'use client';

import { useTour } from './tour-provider';

export function TakeTourButton() {
  const { startTour } = useTour();
  return (
    <button
      type="button"
      onClick={startTour}
      className="text-sm text-cobalt underline-offset-2 hover:underline"
    >
      Take a tour
    </button>
  );
}
