'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getStepById } from '@/lib/tour-steps';
import { useTour } from './tour-provider';

function stepMatchesCurrentPage(page: string, pathname: string): boolean {
  if (page === '') {
    // Dashboard step: pathname is exactly /workspaces/{id} with no further segments.
    return /^\/workspaces\/[^/]+\/?$/.test(pathname);
  }
  return pathname.endsWith(`/${page}`);
}

// Must match the `w-80` Tailwind class on the tooltip below — keep in sync if that changes.
const TOOLTIP_WIDTH = 320;
const TOOLTIP_MARGIN = 20;
// Rough height estimate for vertical clamping; exact height varies with body text length.
const TOOLTIP_HEIGHT_ESTIMATE = 120;

export function TourOverlay() {
  const { activeStepId, nextStep, skipTour } = useTour();
  const pathname = usePathname();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const step = activeStepId ? getStepById(activeStepId) : undefined;
  const onCurrentPage = step ? stepMatchesCurrentPage(step.page, pathname) : false;

  const targetId = step && onCurrentPage ? step.targetId : null;

  useEffect(() => {
    function measure() {
      const el = targetId ? document.querySelector<HTMLElement>(`[data-tour="${targetId}"]`) : null;
      setRect(el ? el.getBoundingClientRect() : null);
    }

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [targetId]);

  const isShowing = Boolean(step && onCurrentPage && rect);

  useEffect(() => {
    if (!isShowing) return undefined;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        skipTour();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isShowing, skipTour]);

  useEffect(() => {
    if (isShowing) {
      tooltipRef.current?.focus();
    }
  }, [isShowing]);

  if (!step || !onCurrentPage || !rect) return null;

  const spaceBelow = window.innerHeight - rect.bottom;
  const tooltipTop =
    spaceBelow >= TOOLTIP_HEIGHT_ESTIMATE + 12
      ? rect.bottom + 12
      : Math.max(12, rect.top - TOOLTIP_HEIGHT_ESTIMATE - 12);
  const tooltipLeft = Math.max(
    12,
    Math.min(rect.left, window.innerWidth - TOOLTIP_WIDTH - TOOLTIP_MARGIN),
  );

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          boxShadow: `0 0 0 9999px rgba(0,0,0,0.55)`,
          top: rect.top - 6,
          left: rect.left - 6,
          width: rect.width + 12,
          height: rect.height + 12,
          borderRadius: 8,
          position: 'fixed',
        }}
      />
      <div
        ref={tooltipRef}
        role="dialog"
        aria-labelledby="tour-step-title"
        tabIndex={-1}
        className="fixed w-80 rounded-lg border border-line bg-panel p-4 shadow-lg outline-none"
        style={{ top: tooltipTop, left: tooltipLeft }}
      >
        <h3 id="tour-step-title" className="text-sm font-bold text-ink">
          {step.title}
        </h3>
        <p className="mt-1.5 text-sm text-sub">{step.body}</p>
        <div className="mt-3 flex justify-between">
          <button
            type="button"
            onClick={skipTour}
            className="text-xs text-sub underline-offset-2 hover:underline"
          >
            Exit tour
          </button>
          <button
            type="button"
            onClick={nextStep}
            className="rounded bg-cobalt px-3 py-1.5 text-xs font-semibold text-white"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
