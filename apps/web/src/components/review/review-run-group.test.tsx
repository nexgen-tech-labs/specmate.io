import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ReviewRunGroup } from './review-run-group';
import type { ReviewItem, RunGroup } from './review-queue';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'item-1',
    type: 'EPIC',
    title: 'An epic',
    description: 'desc',
    status: 'PENDING',
    qualityScore: null,
    scoreDetail: null,
    flags: null,
    parentId: null,
    signedOff: false,
    generationRunId: 'run-1',
    originalDraft: null,
    editHistory: [],
    sources: [],
    publishedKey: null,
    publishedUrl: null,
    duplicateReference: null,
    ...overrides,
  };
}

function run(overrides: Partial<RunGroup> = {}): RunGroup {
  return {
    id: 'run-1',
    name: 'proj-payments-generated01',
    tag: 'payments',
    stage: 'COMPLETE',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderGroup(overrides: Partial<Parameters<typeof ReviewRunGroup>[0]> = {}) {
  return render(
    <ReviewRunGroup
      run={run()}
      items={[item()]}
      workspaceId="ws-1"
      projectId="proj-1"
      base="/api/workspaces/ws-1/projects/proj-1/draft-items"
      canReview={true}
      isAdmin={false}
      approvalStages={1}
      selected={new Set()}
      openId={null}
      editDraft={null}
      gapAnswer=""
      showDiff={false}
      traceItemId={null}
      busy={false}
      flaggedIds={new Set()}
      titleById={new Map()}
      onToggleSelected={vi.fn()}
      onToggleGroup={vi.fn()}
      onToggleOpen={vi.fn()}
      setEditDraft={vi.fn()}
      setGapAnswer={vi.fn()}
      setShowDiff={vi.fn()}
      setTraceItemId={vi.fn()}
      decide={vi.fn().mockResolvedValue(true)}
      call={vi.fn().mockResolvedValue(true)}
      flagRemoved={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />,
  );
}

describe('ReviewRunGroup rename', () => {
  beforeEach(() => {
    refresh.mockClear();
    vi.unstubAllGlobals();
  });

  it('shows the run name and lets a reviewer click to rename it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    renderGroup();

    fireEvent.click(screen.getByText('proj-payments-generated01'));
    const input = screen.getByDisplayValue('proj-payments-generated01');
    fireEvent.change(input, { target: { value: 'renamed-run' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/projects/proj-1/generation-runs/run-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'renamed-run' }) }),
    );
  });

  it('shows an error and does not refresh when renaming to an empty name', async () => {
    renderGroup();
    fireEvent.click(screen.getByText('proj-payments-generated01'));
    const input = screen.getByDisplayValue('proj-payments-generated01');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Name cannot be empty.')).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not allow renaming for a VIEWER (canReview=false)', () => {
    renderGroup({ canReview: false });
    fireEvent.click(screen.getByText('proj-payments-generated01'));
    expect(screen.queryByDisplayValue('proj-payments-generated01')).not.toBeInTheDocument();
  });

  it('falls back to "Untitled run" when the run has no name', () => {
    renderGroup({ run: run({ name: null }) });
    expect(screen.getByText('Untitled run')).toBeInTheDocument();
  });
});
