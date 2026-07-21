# Interactive guided product tour — design

## Goal

Let a user click through the real end-to-end SpecMate flow (upload a source → trigger AI generation → review drafts → publish) with an in-app guided overlay highlighting each step, on demand.

## Scope decisions (from clarifying questions)

- **Format**: in-app guided tour (spotlight/tooltip overlay) over the real production UI — not a separate marketing sandbox, not a video.
- **Trigger**: on-demand only, via a persistent "Take a tour" entry point. Not automatic after onboarding.
- **Data**: drives the user's real workspace — real source upload, real AI generation calls, real review actions, real publish (if a connector is configured). No seeded demo data, no stubbed calls.
- **Implementation**: hand-rolled lightweight overlay component, no new dependency (this repo has zero UI-utility libraries today; adding one is a bigger call than this feature warrants).
- **Cross-page state**: `sessionStorage` + a `?tour=<stepId>` URL param. No backend/DB changes.

## Architecture

### Step registry — `apps/web/src/lib/tour-steps.ts`

```ts
export interface TourStep {
  id: string;
  page: string; // relative path segment appended to the current project's base URL, e.g. "sources"
  targetSelector: string; // matches a data-tour="..." attribute
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'sources-upload',
    page: 'sources',
    targetSelector: 'sources-upload-button',
    title: '...',
    body: '...',
  },
  {
    id: 'generate',
    page: 'get-started',
    targetSelector: 'generate-button',
    title: '...',
    body: '...',
  },
  {
    id: 'review',
    page: 'review',
    targetSelector: 'review-approve-action',
    title: '...',
    body: '...',
  },
  {
    id: 'publish',
    page: 'sources' /* or wherever publish lives */,
    targetSelector: 'publish-button',
    title: '...',
    body: '...',
  },
];
```

Exact `page`/`targetSelector` values confirmed against real route files during planning, not guessed.

### `TourProvider` — React Context, mounted once in the workspace/project layout

- State: `activeStepId: string | null`.
- On mount: reads `sessionStorage.getItem("specmate_tour_step")` and the `?tour=` query param (param wins if both present, so a fresh link always works) to restore `activeStepId`.
- Exposes `startTour()`, `nextStep()`, `skipStep()`, `exitTour()` — each updates state, `sessionStorage`, and (for `nextStep()` crossing pages) calls `router.push()` to the next step's page with `?tour=<id>`.

### `TourOverlay` — rendered once, low in the tree (e.g. workspace layout), always mounted but no-ops when `activeStepId` is null

- If the active step's `page` doesn't match the current route, renders nothing (mid-navigation gap is expected — the destination page picks it up on mount).
- Otherwise: finds `document.querySelector('[data-tour="<targetSelector>"]')`, computes its `getBoundingClientRect()`, renders a dimmed full-page backdrop with a cut-out around the target (CSS `box-shadow` spotlight trick, no canvas needed) and a positioned tooltip box (title/body/Next/Skip/Exit) anchored to the target's edge.
- Re-measures on `resize` and `scroll` (`ResizeObserver` + a scroll listener) so the highlight tracks the target if the page shifts.

### Target elements

Each real component being highlighted gets a `data-tour="<targetSelector>"` attribute added inline — cheap, greppable, no structural changes to the components themselves.

### Entry point

"Take a tour" button added to the workspace dashboard header (near the existing org/workspace breadcrumb), calling `startTour()` which sets step 0 and navigates to its page.

## Testing

- Unit tests for `TourProvider`'s state transitions (start/next/skip/exit, sessionStorage read/write, query-param precedence).
- Unit test for `TourOverlay`'s "renders nothing when step's page doesn't match current route" branch.
- No new backend tests needed (purely client-side).
- Manual click-through verification: start the tour from the dashboard, confirm each step highlights the correct real element across all 4 pages, confirm Skip/Exit work, confirm a full page reload mid-tour resumes correctly via sessionStorage.

## Out of scope

- Automatic triggering after onboarding.
- Cross-device/cross-session persistence (DB-backed).
- Analytics/completion tracking.
- Seeded demo data or stubbed AI/publish calls.
- A new UI/tour dependency.
