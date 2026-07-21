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
