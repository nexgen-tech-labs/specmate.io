import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SourcesCardWithNav } from './dashboard-nav-actions';
import type { SourceSummaryItem } from '@/lib/dashboard';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

const SOURCE: SourceSummaryItem = {
  id: 'src-1',
  name: 'Client-Requirements-v3.docx',
  kind: 'DOCX',
  status: 'PARSED',
  createdAt: new Date(),
  projectId: 'proj-1',
};

describe('SourcesCardWithNav', () => {
  beforeEach(() => {
    refresh.mockClear();
    vi.unstubAllGlobals();
  });

  it('does nothing when the confirm dialog is dismissed', () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<SourcesCardWithNav workspaceId="ws-1" recent={[SOURCE]} onAddSource={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /remove client-requirements-v3\.docx/i }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes the source at its own projectId and refreshes on confirm', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    render(<SourcesCardWithNav workspaceId="ws-1" recent={[SOURCE]} onAddSource={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /remove client-requirements-v3\.docx/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/projects/proj-1/sources/src-1',
      { method: 'DELETE' },
    );
  });

  it('shows an error and does not refresh when the delete request fails', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) }),
    );
    render(<SourcesCardWithNav workspaceId="ws-1" recent={[SOURCE]} onAddSource={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /remove client-requirements-v3\.docx/i }));

    await waitFor(() => expect(screen.getByText('nope')).toBeDefined());
    expect(refresh).not.toHaveBeenCalled();
  });
});
