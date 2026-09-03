import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SourcesCard } from './sources-card';
import type { SourceSummaryItem } from '@/lib/dashboard';

function source(overrides: Partial<SourceSummaryItem> = {}): SourceSummaryItem {
  return {
    id: 'src-1',
    name: 'reqs.docx',
    kind: 'DOCX',
    status: 'PARSED',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    projectId: 'proj-1',
    isGenerated: false,
    ...overrides,
  };
}

describe('SourcesCard generated badge', () => {
  it('shows a GENERATED badge for a source that has contributed to a run', () => {
    render(
      <SourcesCard
        recent={[source({ isGenerated: true })]}
        onAddSource={vi.fn()}
        onRemoveSource={vi.fn()}
      />,
    );
    expect(screen.getByText('GENERATED')).toBeInTheDocument();
  });

  it('shows no badge for a source not yet included in any run', () => {
    render(
      <SourcesCard
        recent={[source({ isGenerated: false })]}
        onAddSource={vi.fn()}
        onRemoveSource={vi.fn()}
      />,
    );
    expect(screen.queryByText('GENERATED')).not.toBeInTheDocument();
  });
});
