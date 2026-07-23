# Interactive guided product tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user click "Take a tour" from the workspace dashboard and be walked, via a spotlight/tooltip overlay, through the real end-to-end flow: create/open a project → the existing get-started wizard (connect a tool, upload a source, generate) → review (approve + publish).

**Architecture:** A hand-rolled `TourProvider` (React Context) + `TourOverlay` component mounted once in the root layout, driven by a step registry. State (`activeStepId`) lives in `sessionStorage` plus a `?tour=<stepId>` URL query param, so it survives full-page navigation between the dashboard, get-started, and review routes. Target elements get a `data-tour="<id>"` attribute added inline — no new dependency.

**Tech Stack:** Next.js 16 App Router, React 19 Client Components, Tailwind CSS. No new npm dependency.

**Real route map this plan targets** (confirmed by reading the actual files, not assumed):

- `/workspaces/{workspaceId}` — dashboard (Server Component, `apps/web/src/app/workspaces/[workspaceId]/page.tsx`) — tour entry point lives here.
- `/workspaces/{workspaceId}/projects/{projectId}/get-started` — a **single page** containing a **self-contained 4-step wizard** (`connect` → `upload` → `generate` → `done`) in `apps/web/src/components/onboarding/onboarding-wizard.tsx`. This is NOT 3 separate page navigations — it's one page with internal step state. The tour treats this as one "page-level" stop with 3 sub-steps keyed to the wizard's own `data-tour` markers.
- `/workspaces/{workspaceId}/projects/{projectId}/review` — review + publish, both on one page (`apps/web/src/components/review/review-queue.tsx`). Bulk-approve/publish buttons only render when `selected.size > 0` (conditional) — the plan targets the always-rendered filter toolbar and per-item checkbox instead, since a tour step must be able to find its target on page load, not after a user has already taken an action.

---

## Task 1: Tour step registry + types

**Files:**

- Create: `apps/web/src/lib/tour-steps.ts`
- Test: `apps/web/src/lib/tour-steps.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/tour-steps.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && npx vitest run src/lib/tour-steps.test.ts
```

Expected: FAIL — `Cannot find module './tour-steps'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/lib/tour-steps.ts`:

```ts
// Interactive guided product tour (demo walkthrough) — step registry. Each step
// names a real page route and a real data-tour="<targetId>" marker already
// present on that page's DOM (or added alongside this feature). The overlay
// (tour-overlay.tsx) renders nothing until the current route matches a step's
// `page`, so navigating between steps is just a normal Next.js navigation with
// a `?tour=<id>` query param carried along.

export interface TourStep {
  id: string;
  /** Path segment(s) appended after `/workspaces/{workspaceId}/projects/{projectId}/`
   * (or, for the dashboard step, appended after `/workspaces/{workspaceId}`).
   * Empty string means "the dashboard itself". */
  page: string;
  targetId: string;
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'dashboard-start',
    page: '',
    targetId: 'new-project-form',
    title: 'Create a project',
    body: "Every SpecMate project starts here — give it a name and you're in.",
  },
  {
    id: 'wizard-connect',
    page: 'get-started',
    targetId: 'wizard-step-connect',
    title: 'Connect a tool (optional)',
    body: 'Link Jira, Azure DevOps, or GitHub now, or skip this — you can always connect later before publishing.',
  },
  {
    id: 'wizard-upload',
    page: 'get-started',
    targetId: 'wizard-step-upload',
    title: 'Upload a source',
    body: 'Drop in a requirements doc, transcript, or spreadsheet — SpecMate parses it into fragments automatically.',
  },
  {
    id: 'wizard-generate',
    page: 'get-started',
    targetId: 'wizard-step-generate',
    title: 'Generate items',
    body: 'SpecMate drafts epics, stories, and acceptance criteria from your source — usually in under a minute.',
  },
  {
    id: 'review-approve',
    page: 'review',
    targetId: 'review-item-list',
    title: 'Review & approve',
    body: 'Every generated item lands here for human review — approve, edit, or reject before anything publishes.',
  },
  {
    id: 'review-publish',
    page: 'review',
    targetId: 'review-toolbar',
    title: 'Publish',
    body: 'Select approved items and publish them straight to Jira, Azure DevOps, or GitHub, fully traced back to their source.',
  },
];

export function getStepById(id: string): TourStep | undefined {
  return TOUR_STEPS.find((s) => s.id === id);
}

export function getNextStep(currentId: string): TourStep | undefined {
  const index = TOUR_STEPS.findIndex((s) => s.id === currentId);
  if (index === -1 || index === TOUR_STEPS.length - 1) return undefined;
  return TOUR_STEPS[index + 1];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && npx vitest run src/lib/tour-steps.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/lib/tour-steps.ts src/lib/tour-steps.test.ts
git add src/lib/tour-steps.ts src/lib/tour-steps.test.ts
git commit -m "Add tour step registry for the guided product tour"
```

---

## Task 2: `TourProvider` — state management

**Files:**

- Create: `apps/web/src/components/tour/tour-provider.tsx`
- Test: `apps/web/src/components/tour/tour-provider.test.tsx`

**Context on testing conventions**: check `apps/web/src/components/onboarding/onboarding-wizard.test.tsx` for the existing React Testing Library + vitest setup style used in this repo before writing this test, so it matches (mocking `next/navigation`'s `useRouter`/`useSearchParams`, etc.).

- [ ] **Step 1: Read the existing test conventions**

```bash
cat apps/web/src/components/onboarding/onboarding-wizard.test.tsx | head -60
```

Note how `useRouter` and any Next.js navigation hooks are mocked (likely via `vi.mock('next/navigation', ...)`). Match that exact pattern in this task's test.

- [ ] **Step 2: Write the failing test**

```tsx
// apps/web/src/components/tour/tour-provider.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TourProvider, useTour } from './tour-provider';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(mockSearch),
  usePathname: () => '/workspaces/ws1/projects/p1/get-started',
}));

let mockSearch = '';

function TestConsumer() {
  const { activeStepId, startTour, nextStep, skipTour } = useTour();
  return (
    <div>
      <span data-testid="active-step">{activeStepId ?? 'none'}</span>
      <button onClick={startTour}>start</button>
      <button onClick={nextStep}>next</button>
      <button onClick={skipTour}>skip</button>
    </div>
  );
}

describe('TourProvider', () => {
  beforeEach(() => {
    pushMock.mockClear();
    mockSearch = '';
    sessionStorage.clear();
  });

  it('starts with no active step', () => {
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    expect(screen.getByTestId('active-step').textContent).toBe('none');
  });

  it('startTour sets the first step and persists it to sessionStorage', () => {
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('start'));
    });
    expect(screen.getByTestId('active-step').textContent).toBe('dashboard-start');
    expect(sessionStorage.getItem('specmate_tour_step')).toBe('dashboard-start');
  });

  it('nextStep advances to the following step and navigates when the page changes', () => {
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('start'));
    });
    act(() => {
      fireEvent.click(screen.getByText('next'));
    });
    expect(screen.getByTestId('active-step').textContent).toBe('wizard-connect');
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('?tour=wizard-connect'));
  });

  it('skipTour clears the active step and sessionStorage', () => {
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('start'));
    });
    act(() => {
      fireEvent.click(screen.getByText('skip'));
    });
    expect(screen.getByTestId('active-step').textContent).toBe('none');
    expect(sessionStorage.getItem('specmate_tour_step')).toBeNull();
  });

  it('restores an in-progress step from the URL query param on mount', () => {
    mockSearch = 'tour=wizard-upload';
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    expect(screen.getByTestId('active-step').textContent).toBe('wizard-upload');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/web && npx vitest run src/components/tour/tour-provider.test.tsx
```

Expected: FAIL — `Cannot find module './tour-provider'`.

- [ ] **Step 4: Write the implementation**

Create `apps/web/src/components/tour/tour-provider.tsx`:

```tsx
'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
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

export function TourProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [activeStepId, setActiveStepId] = useState<string | null>(null);

  // Restore on mount: URL query param wins over sessionStorage (a fresh link
  // with ?tour=<id> always takes precedence over stale in-progress state).
  useEffect(() => {
    const fromQuery = searchParams.get('tour');
    if (fromQuery) {
      setActiveStepId(fromQuery);
      sessionStorage.setItem(STORAGE_KEY, fromQuery);
      return;
    }
    const fromStorage = sessionStorage.getItem(STORAGE_KEY);
    if (fromStorage) setActiveStepId(fromStorage);
    // Intentionally runs once on mount only — subsequent step changes are
    // driven by startTour/nextStep/skipTour, not by re-reading the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startTour = useCallback(() => {
    const first = TOUR_STEPS[0];
    setActiveStepId(first.id);
    sessionStorage.setItem(STORAGE_KEY, first.id);
    const basePath = pathname.split('/').slice(0, 3).join('/'); // /workspaces/{id}
    router.push(`${basePath}?tour=${first.id}`);
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
    // Navigate whenever the next step's page differs from the current one —
    // same-page steps (e.g. within the get-started wizard) just update state,
    // since the wizard itself handles its own internal step transitions.
    const currentSegments = pathname.split('/');
    const projectBase = currentSegments.slice(0, 5).join('/'); // /workspaces/{id}/projects/{id}
    const targetPath = next.page ? `${projectBase}/${next.page}` : projectBase;
    if (!pathname.startsWith(targetPath) || next.page === '') {
      router.push(`${targetPath}?tour=${next.id}`);
    }
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
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/web && npx vitest run src/components/tour/tour-provider.test.tsx
```

Expected: 5 passed. If the `nextStep` navigation test fails because of the base-path slicing logic not matching `/workspaces/ws1/projects/p1/get-started` (5 segments: `['', 'workspaces', 'ws1', 'projects', 'p1']`), adjust the slicing in the implementation — verify with a quick `console.log(pathname.split('/'))` if needed, don't guess blindly.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/components/tour/
git add src/components/tour/tour-provider.tsx src/components/tour/tour-provider.test.tsx
git commit -m "Add TourProvider for guided tour state management"
```

---

## Task 3: `TourOverlay` — spotlight + tooltip rendering

**Files:**

- Create: `apps/web/src/components/tour/tour-overlay.tsx`
- Test: `apps/web/src/components/tour/tour-overlay.test.tsx`

- [ ] **Step 1: Write the failing test**

Note: this test builds its DOM fixture with `document.createElement`/`setAttribute`/`appendChild` rather than `innerHTML`, to avoid the (accurate, generally-good) convention of not writing raw HTML strings into the DOM even in test code.

```tsx
// apps/web/src/components/tour/tour-overlay.test.tsx
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TourOverlay } from './tour-overlay';

const mockUseTour = vi.fn();
vi.mock('./tour-provider', () => ({
  useTour: () => mockUseTour(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/workspaces/ws1/projects/p1/get-started',
}));

function addTourTarget(targetId: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-tour', targetId);
  el.textContent = 'target';
  document.body.appendChild(el);
  return el;
}

describe('TourOverlay', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('renders nothing when no tour is active', () => {
    mockUseTour.mockReturnValue({ activeStepId: null, nextStep: vi.fn(), skipTour: vi.fn() });
    const { container } = render(<TourOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the active step targets a different page than the current route', () => {
    mockUseTour.mockReturnValue({
      activeStepId: 'review-approve', // page: 'review', current pathname ends in get-started
      nextStep: vi.fn(),
      skipTour: vi.fn(),
    });
    const { container } = render(<TourOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the tooltip with the step title/body when the target element exists on the current page', () => {
    mockUseTour.mockReturnValue({
      activeStepId: 'wizard-connect',
      nextStep: vi.fn(),
      skipTour: vi.fn(),
    });
    addTourTarget('wizard-step-connect');
    render(<TourOverlay />);
    expect(screen.getByText('Connect a tool (optional)')).toBeTruthy();
  });

  it('renders nothing when the step is unknown or its target element is not found in the DOM', () => {
    mockUseTour.mockReturnValue({
      activeStepId: 'wizard-connect',
      nextStep: vi.fn(),
      skipTour: vi.fn(),
    });
    // No matching data-tour element added — target genuinely absent.
    const { container } = render(<TourOverlay />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && npx vitest run src/components/tour/tour-overlay.test.tsx
```

Expected: FAIL — `Cannot find module './tour-overlay'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/tour/tour-overlay.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
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

export function TourOverlay() {
  const { activeStepId, nextStep, skipTour } = useTour();
  const pathname = usePathname();
  const [rect, setRect] = useState<DOMRect | null>(null);

  const step = activeStepId ? getStepById(activeStepId) : undefined;
  const onCurrentPage = step ? stepMatchesCurrentPage(step.page, pathname) : false;

  useEffect(() => {
    if (!step || !onCurrentPage) {
      setRect(null);
      return;
    }

    function measure() {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step!.targetId}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    }

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step, onCurrentPage]);

  if (!step || !onCurrentPage || !rect) return null;

  const tooltipTop = rect.bottom + 12;
  const tooltipLeft = Math.max(12, Math.min(rect.left, window.innerWidth - 340));

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="Guided tour">
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
        className="fixed w-80 rounded-lg border border-line bg-panel p-4 shadow-lg"
        style={{ top: tooltipTop, left: tooltipLeft }}
      >
        <h3 className="text-sm font-bold text-ink">{step.title}</h3>
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && npx vitest run src/components/tour/tour-overlay.test.tsx
```

Expected: 4 passed. Note: the `useEffect`-driven `rect` state means the third test (renders tooltip) relies on the effect running synchronously enough for `@testing-library/react`'s `render` to reflect it — if it doesn't pass on the first attempt, wrap the assertion in `waitFor` from `@testing-library/react` instead of a bare `expect`, following whatever async-effect testing pattern already exists elsewhere in this repo's component tests (grep for `waitFor` in `apps/web/src/components/**/*.test.tsx` for precedent).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/components/tour/
git add src/components/tour/tour-overlay.tsx src/components/tour/tour-overlay.test.tsx
git commit -m "Add TourOverlay spotlight/tooltip rendering"
```

---

## Task 4: Mount the provider + overlay in the root layout

**Files:**

- Modify: `apps/web/src/app/layout.tsx`

The root layout is currently a Server Component with no `'use client'` boundary. `TourProvider`/`TourOverlay` are client components, so they can be rendered as children of the server layout directly (Next.js allows Server Components to render Client Components as children without the parent itself becoming a Client Component).

- [ ] **Step 1: Modify `apps/web/src/app/layout.tsx`**

```tsx
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Suspense } from 'react';
import './globals.css';
import { TourProvider } from '@/components/tour/tour-provider';
import { TourOverlay } from '@/components/tour/tour-overlay';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'SpecMate — AI Delivery Spec Layer',
  description:
    'Messy requirements in, approved work items out. AI-drafted, quality-scored, human-approved, and published to Jira, Azure DevOps, or GitHub.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <Suspense fallback={null}>
          <TourProvider>
            {children}
            <TourOverlay />
          </TourProvider>
        </Suspense>
      </body>
    </html>
  );
}
```

Note: `TourProvider` uses `useSearchParams()`, which requires a `<Suspense>` boundary around it in the Next.js App Router (App Router will fail the build otherwise, since `useSearchParams()` opts a component out of static rendering). Wrapping at the layout level is the correct fix — check `apps/web/src/app/onboarding/page.tsx` or similar for an existing `Suspense`-around-`useSearchParams` precedent in this repo if one exists, to match the established pattern; if none exists, the wrapping above is standard Next.js App Router practice.

- [ ] **Step 2: Verify the app still builds and boots**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: no errors. If there's a Suspense-related build error, check the exact Next.js error message and adjust boundary placement — don't guess.

- [ ] **Step 3: Manual smoke test**

```bash
cd apps/web && pnpm dev &
sleep 5
curl -s http://localhost:3000 -o /dev/null -w "%{http_code}\n"
kill %1
```

Expected: `200` (or a redirect to login, which is also fine — confirms the app boots without a runtime error from the new layout wrapping).

- [ ] **Step 4: Lint, commit**

```bash
cd apps/web
npx eslint src/app/layout.tsx
git add src/app/layout.tsx
git commit -m "Mount TourProvider/TourOverlay in the root layout"
```

---

## Task 5: "Take a tour" entry point on the dashboard

**Files:**

- Modify: `apps/web/src/app/workspaces/[workspaceId]/page.tsx`
- Create: `apps/web/src/components/tour/take-tour-button.tsx` (small client component — the dashboard page itself is a Server Component and can't call `useTour()` directly)
- Test: `apps/web/src/components/tour/take-tour-button.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/tour/take-tour-button.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TakeTourButton } from './take-tour-button';

const startTourMock = vi.fn();
vi.mock('./tour-provider', () => ({
  useTour: () => ({ startTour: startTourMock }),
}));

describe('TakeTourButton', () => {
  it('renders a button that calls startTour on click', () => {
    render(<TakeTourButton />);
    fireEvent.click(screen.getByText('Take a tour'));
    expect(startTourMock).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && npx vitest run src/components/tour/take-tour-button.test.tsx
```

Expected: FAIL — `Cannot find module './take-tour-button'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/tour/take-tour-button.tsx`:

```tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && npx vitest run src/components/tour/take-tour-button.test.tsx
```

Expected: 1 passed.

- [ ] **Step 5: Wire it into the dashboard page**

Modify `apps/web/src/app/workspaces/[workspaceId]/page.tsx` — add the import and render `<TakeTourButton />` next to the existing Invite/Billing links (inside the `access.membership.role === 'ADMIN'` block is too restrictive since any role should be able to take the tour; place it as its own always-visible element instead). Also add `data-tour="new-project-form"` to the `NewProjectForm` wrapper div, since Task 1's step registry targets it for the `dashboard-start` step.

Locate this block (already read in full during planning):

```tsx
<div className="mb-8 flex items-end justify-between">
  <div>
    {orgBreadcrumb ? (
      <div className="mb-1.5 font-mono text-xs text-sub">{orgBreadcrumb}</div>
    ) : null}
    <h1 className="text-3xl font-bold tracking-tight text-ink">{workspace.name}</h1>
    <p className="mt-2 text-base text-sub">Your projects</p>
  </div>
  {access.membership.role === 'ADMIN' ? (
    <div className="flex flex-col items-end gap-1">
      <Link
        href={`/workspaces/${workspaceId}/invite`}
        className="text-sm text-cobalt underline-offset-2 hover:underline"
      >
        Invite teammate →
      </Link>
      <Link
        href={`/workspaces/${workspaceId}/billing`}
        className="text-sm text-cobalt underline-offset-2 hover:underline"
      >
        Billing →
      </Link>
    </div>
  ) : null}
</div>
```

Replace with:

```tsx
<div className="mb-8 flex items-end justify-between">
  <div>
    {orgBreadcrumb ? (
      <div className="mb-1.5 font-mono text-xs text-sub">{orgBreadcrumb}</div>
    ) : null}
    <h1 className="text-3xl font-bold tracking-tight text-ink">{workspace.name}</h1>
    <p className="mt-2 text-base text-sub">Your projects</p>
  </div>
  <div className="flex flex-col items-end gap-1">
    <TakeTourButton />
    {access.membership.role === 'ADMIN' ? (
      <>
        <Link
          href={`/workspaces/${workspaceId}/invite`}
          className="text-sm text-cobalt underline-offset-2 hover:underline"
        >
          Invite teammate →
        </Link>
        <Link
          href={`/workspaces/${workspaceId}/billing`}
          className="text-sm text-cobalt underline-offset-2 hover:underline"
        >
          Billing →
        </Link>
      </>
    ) : null}
  </div>
</div>
```

Add the import near the top of the file (alongside the existing `NewProjectForm` import):

```tsx
import { TakeTourButton } from '@/components/tour/take-tour-button';
```

Then find the two `<NewProjectForm ... />` usages (one in the empty-state branch, one below the projects list) and wrap each in a `<div data-tour="new-project-form">`:

```tsx
{
  canCreate ? (
    <div data-tour="new-project-form" className="mt-6">
      <NewProjectForm workspaceId={workspaceId} redirectToWizard />
    </div>
  ) : null;
}
```

and

```tsx
{
  canCreate ? (
    <div data-tour="new-project-form" className="mt-6">
      <NewProjectForm workspaceId={workspaceId} />
    </div>
  ) : null;
}
```

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/app/workspaces/\[workspaceId\]/page.tsx src/components/tour/take-tour-button.tsx src/components/tour/take-tour-button.test.tsx
git add src/app/workspaces/\[workspaceId\]/page.tsx src/components/tour/take-tour-button.tsx src/components/tour/take-tour-button.test.tsx
git commit -m "Add 'Take a tour' entry point to the workspace dashboard"
```

---

## Task 6: `data-tour` markers on the onboarding wizard steps

**Files:**

- Modify: `apps/web/src/components/onboarding/onboarding-wizard.tsx`

This wizard already has internal step state (`connect` → `upload` → `generate` → `done`, confirmed by reading the file during planning: `STEPS` array at line 10, `step === 'connect'`/`step === 'upload'`/`step === 'generate'` conditional blocks at lines 118/168/216). Add a `data-tour` attribute to each step's outermost rendered container so the tour overlay can find and highlight it. Do NOT change any of the wizard's existing logic — this is purely additive markup.

- [ ] **Step 1: Read the exact current structure**

```bash
grep -n "step === '" apps/web/src/components/onboarding/onboarding-wizard.tsx
```

Confirm the exact line numbers and JSX structure around each `step === 'connect'`, `step === 'upload'`, `step === 'generate'` block before editing — these may have shifted since planning.

- [ ] **Step 2: Add `data-tour` to each step's container**

For the `connect` step block (originally around line 118, `{step === 'connect' ? (`), find its outermost returned JSX element (likely a `<div>` immediately after the ternary opens) and add `data-tour="wizard-step-connect"` to it.

For the `upload` step block (originally around line 168), add `data-tour="wizard-step-upload"` to its outermost container.

For the `generate` step block (originally around line 216), add `data-tour="wizard-step-generate"` to its outermost container.

Example of the pattern (adapt to the actual JSX found in Step 1 — don't assume the exact shape without checking):

```tsx
{
  step === 'connect' ? (
    <div data-tour="wizard-step-connect">{/* existing content unchanged */}</div>
  ) : null;
}
```

If the outermost element already has a `className` or other attributes, just add `data-tour="..."` alongside them — don't restructure the JSX.

- [ ] **Step 3: Verify no existing tests broke**

```bash
cd apps/web && npx vitest run src/components/onboarding/onboarding-wizard.test.tsx
```

Expected: all existing tests still pass (this change is additive-only markup, should not affect any assertion).

- [ ] **Step 4: Typecheck, lint, commit**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/components/onboarding/onboarding-wizard.tsx
git add src/components/onboarding/onboarding-wizard.tsx
git commit -m "Add data-tour markers to onboarding wizard steps"
```

---

## Task 7: `data-tour` markers on the review page

**Files:**

- Modify: `apps/web/src/components/review/review-queue.tsx`

Per the plan header's route map: bulk-action buttons only render when items are selected, so they're not safe always-visible targets. This task targets the filter toolbar (always rendered) for the "publish" step and the item list container (always rendered, even when empty) for the "approve" step.

- [ ] **Step 1: Read the exact current structure**

```bash
grep -n "className=\"mb-4 flex\|<ul className=\"space-y-2\"" apps/web/src/components/review/review-queue.tsx
```

Confirm the exact current line numbers for the filter toolbar container (the `<div>` wrapping the type filters and, conditionally, the bulk-action buttons — confirmed during planning to start around line 200-217) and the `<ul className="space-y-2">` item list (confirmed around line 267) before editing.

- [ ] **Step 2: Add `data-tour="review-toolbar"` to the filter toolbar container**

Find the outermost `<div>` that wraps the type-filter links and the conditional bulk-action button group (the parent of the `{canReview && selected.size > 0 ? (...) : null}` block). Add `data-tour="review-toolbar"` to it — this element is always rendered regardless of selection state, so it's a stable target even though the actual Publish buttons inside it are conditional. The tour step's copy (`review-publish` in `tour-steps.ts`) should be read as "select items above, then publish from this toolbar" framing, which already matches the body text written in Task 1.

- [ ] **Step 3: Add `data-tour="review-item-list"` to the item list**

Find `<ul className="space-y-2">{items.map(...)}</ul>` and add `data-tour="review-item-list"` to the `<ul>` element. This is always rendered (even the "No items match this filter" paragraph sits right above it), so it's a safe target for the `review-approve` step regardless of whether any items exist yet.

- [ ] **Step 4: Verify no existing tests broke**

```bash
cd apps/web && npx vitest run src/components/review/
```

Expected: all existing review-related tests still pass.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd apps/web
npx tsc --noEmit
npx eslint src/components/review/review-queue.tsx
git add src/components/review/review-queue.tsx
git commit -m "Add data-tour markers to the review page"
```

---

## Task 8: Full regression pass + manual click-through verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full web test suite**

```bash
cd apps/web && npx vitest run
```

Expected: all tests pass, including every new test from Tasks 1-3 and 5, plus every pre-existing test unaffected.

- [ ] **Step 2: Full typecheck + lint sweep**

```bash
cd apps/web
npx tsc --noEmit
npx eslint .
```

Expected: both clean.

- [ ] **Step 3: Manual click-through**

```bash
cd apps/web && pnpm dev
```

In a browser:

1. Log in, land on the workspace dashboard.
2. Click "Take a tour" — confirm the spotlight highlights the new-project form area with a tooltip reading "Create a project".
3. Click "Next →" — confirm navigation to (or highlighting within) the get-started wizard, spotlighting the "Connect a tool" step.
4. Continue clicking "Next →" through upload and generate steps — confirm each spotlight lands on the correct wizard sub-step.
5. Continue to the review page — confirm the spotlight highlights the item list, then the toolbar.
6. Click "Exit tour" partway through — confirm the overlay disappears and does not reappear on a page refresh.
7. Reload the browser mid-tour (before clicking Exit) — confirm the tour resumes at the same step via sessionStorage.

Report the actual observed behavior at each numbered point — don't just assert "it worked," describe what was seen.

- [ ] **Step 4: Update `architecture.md`**

Add a new subsection (search for the most recent `### ` entry in `architecture.md` and insert this one after it, before the next `## ` numbered section):

```markdown
### Interactive guided product tour (`apps/web/src/components/tour/`, `apps/web/src/lib/tour-steps.ts`)

An on-demand, hand-rolled spotlight/tooltip overlay (no new dependency) that walks a user through the real end-to-end flow — create a project, the get-started wizard's connect/upload/generate steps, then review/publish — by highlighting real, already-rendered UI elements marked with `data-tour="..."` attributes. `TourProvider` (React Context, mounted in the root layout) tracks the active step in `sessionStorage` plus a `?tour=<stepId>` URL query param, so state survives full-page navigation between the dashboard, get-started, and review routes without any backend/DB involvement — this is purely client-side, ephemeral UI guidance, not a tracked/resumable-across-devices feature. `TourOverlay` renders nothing unless the active step's target element actually exists on the current page (found via `document.querySelector`), so a step "waits" safely across a navigation gap rather than erroring. Triggered via a "Take a tour" button on the workspace dashboard — not automatic after onboarding. Drives the user's real workspace: real source upload, real AI generation, real review actions, real publish — no seeded demo data or stubbed calls.
```

- [ ] **Step 5: Commit the architecture.md update**

```bash
git add architecture.md
git commit -m "Document the interactive guided product tour in architecture.md"
```

---

## Self-review notes (for the plan author, already applied above)

- **Spec coverage**: on-demand trigger (Task 5), real workspace data / no seeded content (no task stubs any AI/publish call — the tour only adds markup and navigation, never intercepts real actions), hand-rolled overlay / no new dependency (Tasks 2-3 are plain React + Tailwind), sessionStorage + query-param cross-page state (Task 2) — all covered.
- **Type consistency**: `TourStep`/`getStepById`/`getNextStep` signatures from Task 1 are used identically in Task 2's `TourProvider` and Task 3's `TourOverlay`. `useTour()`'s returned shape (`activeStepId`, `startTour`, `nextStep`, `skipTour`) is consistent across Tasks 2, 3, and 5.
- **No placeholders**: every step has runnable code, exact commands, or an explicit "read the real file first, don't guess" instruction where the plan's own line-number references might have drifted (Tasks 6 and 7 explicitly call this out, since those files may change between planning and execution).
- **Known real-UI constraint documented up front**: the plan's header explicitly notes the get-started page is one route with an internal wizard (not 3 separate page navigations) and that review's bulk-action buttons are conditionally rendered — both discovered by reading the actual files during planning, not assumed from the original design doc's more generic 4-page description.
