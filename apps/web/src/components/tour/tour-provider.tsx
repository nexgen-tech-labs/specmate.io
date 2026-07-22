'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { TOUR_STEPS, getNextStep } from '@/lib/tour-steps';

const STORAGE_KEY = 'specmate_tour_step';

interface TourContextValue {
  activeStepId: string | null;
  startTour: () => void;
  nextStep: () => void;
  skipTour: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used within a TourProvider');
  return ctx;
}

/**
 * Builds the destination path for a tour step given the current pathname.
 *
 * Route shapes in this app:
 *   - dashboard-start: /workspaces/{workspaceId}                 (page === '')
 *   - all other steps: /workspaces/{workspaceId}/projects/{projectId}/{page}
 *
 * We derive both ids from the current pathname's segments so this works no
 * matter which of the two shapes the user is currently on.
 */
function buildStepPath(pathname: string, page: string): string {
  const segments = pathname.split('/').filter(Boolean); // ['workspaces', wsId, 'projects', projId, ...]
  const workspaceId = segments[1];
  if (page === '') {
    return `/workspaces/${workspaceId}`;
  }
  const projectId = segments[3];
  return `/workspaces/${workspaceId}/projects/${projectId}/${page}`;
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Restore on first render: URL query param wins over sessionStorage (a
  // fresh link with ?tour=<id> always takes precedence over stale
  // in-progress state). Computed via the lazy useState initializer rather
  // than an effect so there's no extra render/flash of `null` on mount.
  const [activeStepId, setActiveStepId] = useState<string | null>(() => {
    // Client Components are still rendered on the server for the initial
    // HTML; sessionStorage/window don't exist there, so guard against SSR.
    // The client re-runs this initializer on mount and restores state then.
    if (typeof window === 'undefined') return null;
    const fromQuery = searchParams.get('tour');
    if (fromQuery) {
      sessionStorage.setItem(STORAGE_KEY, fromQuery);
      return fromQuery;
    }
    return sessionStorage.getItem(STORAGE_KEY);
  });

  const startTour = useCallback(() => {
    const first = TOUR_STEPS[0];
    setActiveStepId(first.id);
    sessionStorage.setItem(STORAGE_KEY, first.id);
    const targetPath = buildStepPath(pathname, first.page);
    router.push(`${targetPath}?tour=${first.id}`);
  }, [pathname, router]);

  const nextStep = useCallback(() => {
    if (!activeStepId) return;
    const next = getNextStep(activeStepId);
    if (!next) {
      setActiveStepId(null);
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    setActiveStepId(next.id);
    sessionStorage.setItem(STORAGE_KEY, next.id);
    // Always update the URL's ?tour= param so the active step survives a
    // refresh or is shareable via link, even when the target page is the
    // same as the current one (e.g. moving between steps within the
    // get-started wizard).
    const targetPath = buildStepPath(pathname, next.page);
    router.push(`${targetPath}?tour=${next.id}`);
  }, [activeStepId, pathname, router]);

  const skipTour = useCallback(() => {
    setActiveStepId(null);
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  return (
    <TourContext.Provider value={{ activeStepId, startTour, nextStep, skipTour }}>
      {children}
    </TourContext.Provider>
  );
}
