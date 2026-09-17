import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SourceList, type SourceRow } from './source-list';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

const pollJobFromBrowser = vi.fn();
vi.mock('@/lib/poll-job', () => ({
  pollJobFromBrowser: (...args: unknown[]) => pollJobFromBrowser(...args),
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

describe('SourceList targeted regenerate', () => {
  beforeEach(() => {
    push.mockClear();
    pollJobFromBrowser.mockReset();
    vi.unstubAllGlobals();
  });

  it('enqueues a job and navigates to delta-review once it completes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ job_id: 'job-1' }) }),
    );
    pollJobFromBrowser.mockResolvedValue({ status: 'DONE', result_ref: null, error: null });
    render(
      <SourceList
        workspaceId="ws-1"
        projectId="proj-1"
        sources={[sourceRow({ isNewVersion: true, hasDiff: true })]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /regenerate delta/i }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        '/workspaces/ws-1/projects/proj-1/sources/src-1/delta-review',
      ),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/projects/proj-1/sources/src-1/targeted-regenerate',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(pollJobFromBrowser).toHaveBeenCalledWith('job-1');
  });

  it('shows an error and does not navigate when the job fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ job_id: 'job-1' }) }),
    );
    pollJobFromBrowser.mockResolvedValue({
      status: 'FAILED',
      result_ref: null,
      error: 'No diff available for this source version.',
    });
    render(
      <SourceList
        workspaceId="ws-1"
        projectId="proj-1"
        sources={[sourceRow({ isNewVersion: true, hasDiff: true })]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /regenerate delta/i }));

    await waitFor(() =>
      expect(screen.getByText('No diff available for this source version.')).toBeInTheDocument(),
    );
    expect(push).not.toHaveBeenCalled();
  });
});
