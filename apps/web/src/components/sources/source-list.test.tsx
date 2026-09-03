import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SourceList, type SourceRow } from './source-list';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function sourceRow(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 'src-1',
    name: 'reqs.docx',
    kind: 'DOCX',
    status: 'PARSED',
    parseError: null,
    fragmentCount: 5,
    updatedAt: '2026-09-01T00:00:00.000Z',
    isNewVersion: false,
    hasDiff: false,
    isGenerated: false,
    ...overrides,
  };
}

describe('SourceList generated badge', () => {
  it('shows a GENERATED badge for a source that has contributed to a run', () => {
    render(
      <SourceList
        workspaceId="ws-1"
        projectId="proj-1"
        sources={[sourceRow({ isGenerated: true })]}
      />,
    );
    expect(screen.getByText('GENERATED')).toBeInTheDocument();
  });

  it('shows no badge for a source not yet included in any run', () => {
    render(
      <SourceList
        workspaceId="ws-1"
        projectId="proj-1"
        sources={[sourceRow({ isGenerated: false })]}
      />,
    );
    expect(screen.queryByText('GENERATED')).not.toBeInTheDocument();
  });
});
