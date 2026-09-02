import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ReviewQueue, type ReviewItem, type RunGroup } from './review-queue';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

function renderQueue(overrides: Partial<Parameters<typeof ReviewQueue>[0]> = {}) {
  return render(
    <ReviewQueue
      workspaceId="ws-1"
      projectId="proj-1"
      items={[]}
      canReview={true}
      isAdmin={false}
      approvalStages={1}
      activeFilters={{}}
      totalItemCount={0}
      sourceCount={0}
      latestRunId={null}
      latestRunStage={null}
      runs={[]}
      {...overrides}
    />,
  );
}

function epicItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'epic-1',
    type: 'EPIC',
    title: 'An epic',
    description: 'desc',
    status: 'PENDING',
    qualityScore: null,
    scoreDetail: null,
    flags: null,
    parentId: null,
    signedOff: false,
    generationRunId: null,
    originalDraft: null,
    editHistory: [],
    sources: [],
    publishedKey: null,
    publishedUrl: null,
    duplicateReference: null,
    ...overrides,
  };
}

function runGroup(overrides: Partial<RunGroup> = {}): RunGroup {
  return {
    id: 'run-1',
    name: 'proj-payments-generated01',
    tag: 'payments',
    stage: 'COMPLETE',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ReviewQueue empty states', () => {
  it('shows a "no sources yet" get-started prompt when the project has zero sources and zero items', () => {
    renderQueue({ totalItemCount: 0, sourceCount: 0 });
    expect(screen.getByText('This project has no sources yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get started/i })).toHaveAttribute(
      'href',
      '/workspaces/ws-1/projects/proj-1/get-started',
    );
    expect(screen.queryByText('No items match this filter.')).not.toBeInTheDocument();
  });

  it('shows a "no items generated yet" get-started prompt when sources exist but generation hasn\'t run', () => {
    renderQueue({ totalItemCount: 0, sourceCount: 2 });
    expect(screen.getByText('No items generated yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get started/i })).toBeInTheDocument();
  });

  it('shows the generic filter message (not the get-started prompt) when items exist but the current filter excludes all of them', () => {
    renderQueue({ totalItemCount: 5, sourceCount: 1, items: [] });
    expect(screen.getByText('No items match this filter.')).toBeInTheDocument();
    expect(screen.queryByText('This project has no sources yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /get started/i })).not.toBeInTheDocument();
  });

  it('shows neither empty-state message when items are present', () => {
    renderQueue({
      totalItemCount: 1,
      sourceCount: 1,
      items: [
        {
          id: 'item-1',
          type: 'STORY',
          title: 'A story',
          description: 'desc',
          status: 'PENDING',
          qualityScore: null,
          scoreDetail: null,
          flags: null,
          parentId: null,
          signedOff: false,
          generationRunId: null,
          originalDraft: null,
          editHistory: [],
          sources: [],
          publishedKey: null,
          publishedUrl: null,
          duplicateReference: null,
        },
      ],
    });
    expect(screen.queryByText('No items match this filter.')).not.toBeInTheDocument();
    expect(screen.queryByText('This project has no sources yet.')).not.toBeInTheDocument();
  });
});

describe('ReviewQueue staged-generation banner', () => {
  beforeEach(() => {
    refresh.mockClear();
    vi.unstubAllGlobals();
  });

  it('shows the pending-review banner with a disabled button when no epic is approved yet', () => {
    renderQueue({
      latestRunId: 'run-1',
      latestRunStage: 'EPICS_PENDING_REVIEW',
      totalItemCount: 2,
      items: [epicItem({ id: 'epic-1' }), epicItem({ id: 'epic-2', status: 'REJECTED' })],
    });
    expect(screen.getByText(/2 epics generated/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate stories & tasks/i })).toBeDisabled();
  });

  it('enables the button once at least one epic is approved, and calls generate-downstream then refreshes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    renderQueue({
      latestRunId: 'run-1',
      latestRunStage: 'EPICS_PENDING_REVIEW',
      totalItemCount: 2,
      items: [
        epicItem({ id: 'epic-1', status: 'APPROVED' }),
        epicItem({ id: 'epic-2', status: 'REJECTED' }),
      ],
    });

    const button = screen.getByRole('button', { name: /generate stories & tasks/i });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/projects/proj-1/generation-runs/run-1/generate-downstream',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows an error and does not refresh when generate-downstream fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ detail: 'No approved epics' }) }),
    );
    renderQueue({
      latestRunId: 'run-1',
      latestRunStage: 'EPICS_PENDING_REVIEW',
      totalItemCount: 1,
      items: [epicItem({ id: 'epic-1', status: 'APPROVED' })],
    });

    fireEvent.click(screen.getByRole('button', { name: /generate stories & tasks/i }));

    await waitFor(() => expect(screen.getByText('No approved epics')).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not show the banner once the run is COMPLETE', () => {
    renderQueue({
      latestRunId: 'run-1',
      latestRunStage: 'COMPLETE',
      totalItemCount: 1,
      items: [epicItem({ id: 'epic-1', status: 'APPROVED' })],
    });
    expect(screen.queryByText(/epics generated/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /generate stories & tasks/i }),
    ).not.toBeInTheDocument();
  });

  it('does not show the button for a VIEWER (canReview=false)', () => {
    renderQueue({
      canReview: false,
      latestRunId: 'run-1',
      latestRunStage: 'EPICS_PENDING_REVIEW',
      totalItemCount: 1,
      items: [epicItem({ id: 'epic-1', status: 'APPROVED' })],
    });
    expect(screen.getByText(/1 epic generated/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /generate stories & tasks/i }),
    ).not.toBeInTheDocument();
  });
});

function storyItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'story-1',
    type: 'STORY',
    title: 'A story',
    description: 'desc',
    status: 'PENDING',
    qualityScore: null,
    scoreDetail: null,
    flags: null,
    parentId: null,
    signedOff: false,
    generationRunId: null,
    originalDraft: null,
    editHistory: [],
    sources: [],
    publishedKey: null,
    publishedUrl: null,
    duplicateReference: null,
    ...overrides,
  };
}

describe('ReviewQueue run grouping', () => {
  it('renders one collapsible section per run, each labeled with its name', () => {
    renderQueue({
      runs: [
        runGroup({ id: 'run-1', name: 'proj-payments-generated01' }),
        runGroup({ id: 'run-2', name: 'proj-billing-generated02' }),
      ],
      items: [
        storyItem({ id: 's1', generationRunId: 'run-1' }),
        storyItem({ id: 's2', generationRunId: 'run-2' }),
      ],
      totalItemCount: 2,
    });

    expect(screen.getByText('proj-payments-generated01')).toBeInTheDocument();
    expect(screen.getByText('proj-billing-generated02')).toBeInTheDocument();
    expect(document.querySelectorAll('details[data-tour="review-run-group"]')).toHaveLength(2);
  });

  it('falls back to an Ungrouped section for items with no generationRunId', () => {
    renderQueue({
      runs: [runGroup({ id: 'run-1', name: 'proj-payments-generated01' })],
      items: [
        storyItem({ id: 's1', generationRunId: 'run-1' }),
        storyItem({ id: 's2', generationRunId: null }),
      ],
      totalItemCount: 2,
    });

    expect(screen.getByText('proj-payments-generated01')).toBeInTheDocument();
    expect(screen.getByText('Ungrouped')).toBeInTheDocument();
  });

  it('global select-all selects items across every group, and toggling again clears it', () => {
    renderQueue({
      runs: [
        runGroup({ id: 'run-1', name: 'proj-payments-generated01' }),
        runGroup({ id: 'run-2', name: 'proj-billing-generated02' }),
      ],
      items: [
        storyItem({ id: 's1', generationRunId: 'run-1' }),
        storyItem({ id: 's2', generationRunId: 'run-2' }),
      ],
      totalItemCount: 2,
    });

    fireEvent.click(screen.getByLabelText('Select all'));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Select all'));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("a group's own select-all only selects that group's items", () => {
    renderQueue({
      runs: [
        runGroup({ id: 'run-1', name: 'proj-payments-generated01' }),
        runGroup({ id: 'run-2', name: 'proj-billing-generated02' }),
      ],
      items: [
        storyItem({ id: 's1', generationRunId: 'run-1' }),
        storyItem({ id: 's2', generationRunId: 'run-2' }),
      ],
      totalItemCount: 2,
    });

    const groupCheckboxes = document.querySelectorAll('summary input[type="checkbox"]');
    expect(groupCheckboxes).toHaveLength(2);
    fireEvent.click(groupCheckboxes[0]);

    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});

describe('ReviewQueue status filter chips', () => {
  it('links to the status-filtered URL and highlights the active status', () => {
    renderQueue({ activeFilters: { status: 'APPROVED' } });

    // The already-active chip's link clears the filter (toggle-off); the
    // active state is instead shown via styling, asserted below.
    const approvedChip = screen.getByRole('link', { name: 'APPROVED' });
    expect(approvedChip).toHaveAttribute('href', '/workspaces/ws-1/projects/proj-1/review');
    expect(approvedChip.className).toContain('border-cobalt');

    const pendingChip = screen.getByRole('link', { name: 'PENDING' });
    expect(pendingChip).toHaveAttribute(
      'href',
      '/workspaces/ws-1/projects/proj-1/review?status=PENDING',
    );
  });

  it('clicking the active status chip again clears the filter', () => {
    renderQueue({ activeFilters: { status: 'REJECTED' } });
    const chip = screen.getByRole('link', { name: 'REJECTED' });
    expect(chip).toHaveAttribute('href', '/workspaces/ws-1/projects/proj-1/review');
  });
});
