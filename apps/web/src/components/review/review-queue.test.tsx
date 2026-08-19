import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReviewQueue } from './review-queue';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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
      {...overrides}
    />,
  );
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
