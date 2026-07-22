'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { TOUR_STEPS, getNextStep, getStepById } from '@/lib/tour-steps';

const STORAGE_KEY = 'specmate_tour_step';

// Tour steps whose "advance" happens as a side effect of the wizard doing its
// own real primary action (skip/continue/generate), rather than the tour
// immediately flipping activeStepId itself. See nextStep()/syncWizardStep().
const WIZARD_TOUR_STEP_IDS = new Set(['wizard-connect', 'wizard-upload', 'wizard-generate']);

// Maps OnboardingWizard's internal step keys to the corresponding tour step
// id. 'done' isn't itself a tour step — the wizard finishing means the tour
// should move on to the next step after wizard-generate (review-approve).
const WIZARD_STEP_TO_TOUR_STEP: Record<'connect' | 'upload' | 'generate' | 'done', string> = {
  connect: 'wizard-connect',
  upload: 'wizard-upload',
  generate: 'wizard-generate',
  done: 'review-approve',
};

interface TourContextValue {
  activeStepId: string | null;
  startTour: () => void;
  nextStep: () => void;
  skipTour: () => void;
  /** Increments whenever nextStep() is called while a wizard step is active;
   * OnboardingWizard watches this to trigger its own real primary action. */
  wizardAdvanceSignal: number;
  /** Called by OnboardingWizard whenever its own internal step state changes,
   * so the tour's activeStepId mirrors the wizard's true state instead of
   * being driven independently. No-op if no wizard tour step is active. */
  syncWizardStep: (wizardStep: 'connect' | 'upload' | 'generate' | 'done') => void;
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

  const [wizardAdvanceSignal, setWizardAdvanceSignal] = useState(0);

  const startTour = useCallback(() => {
    const first = TOUR_STEPS[0];
    setActiveStepId(first.id);
    sessionStorage.setItem(STORAGE_KEY, first.id);
    const targetPath = buildStepPath(pathname, first.page);
    router.push(`${targetPath}?tour=${first.id}`);
  }, [pathname, router]);

  const nextStep = useCallback(() => {
    if (!activeStepId) return;
    // Wizard steps don't advance directly here — the tour can't drive the
    // wizard's real UI itself, so it signals OnboardingWizard to perform its
    // own real primary action (skip/continue/generate) for the current step.
    // OnboardingWizard's onStepChange callback (-> syncWizardStep) is what
    // actually moves activeStepId forward for these three steps.
    if (WIZARD_TOUR_STEP_IDS.has(activeStepId)) {
      setWizardAdvanceSignal((n) => n + 1);
      return;
    }
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
    router.push(pathname);
  }, [pathname, router]);

  const syncWizardStep = useCallback(
    (wizardStep: 'connect' | 'upload' | 'generate' | 'done') => {
      if (!activeStepId || !WIZARD_TOUR_STEP_IDS.has(activeStepId)) return;
      const mapped = WIZARD_STEP_TO_TOUR_STEP[wizardStep];
      if (mapped === activeStepId) return;
      setActiveStepId(mapped);
      sessionStorage.setItem(STORAGE_KEY, mapped);
      // Keep the URL's ?tour= param in sync for refresh/share-link behavior,
      // matching nextStep()'s existing convention — but only while we're
      // still on the wizard's own page (wizard-connect -> wizard-upload ->
      // wizard-generate all live on get-started). The 'done' -> review-approve
      // mapping crosses to a different page (/review); we must NOT push that
      // navigation ourselves, since the wizard shows its own "done" screen
      // and lets the user click "Go to Review" — auto-navigating here would
      // yank them off that screen. The tour simply stays dormant (overlay
      // finds itself off-page) until the user gets to /review on their own,
      // at which point activeStepId is already 'review-approve' and the
      // overlay picks the target right up.
      const mappedStep = getStepById(mapped);
      if (mappedStep && mappedStep.page === 'get-started') {
        const targetPath = buildStepPath(pathname, mappedStep.page);
        router.push(`${targetPath}?tour=${mapped}`);
      }
    },
    [activeStepId, pathname, router],
  );

  return (
    <TourContext.Provider
      value={{ activeStepId, startTour, nextStep, skipTour, wizardAdvanceSignal, syncWizardStep }}
    >
      {children}
    </TourContext.Provider>
  );
}
