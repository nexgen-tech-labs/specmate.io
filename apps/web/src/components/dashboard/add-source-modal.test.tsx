import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AddSourceModal } from './add-source-modal';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

vi.mock('@/components/sources/upload-zone', () => ({
  UploadZone: () => <div>upload-zone-rendered</div>,
}));

describe('AddSourceModal', () => {
  beforeEach(() => {
    refresh.mockClear();
    vi.unstubAllGlobals();
  });

  it('defaults to the upload tab', () => {
    render(<AddSourceModal workspaceId="ws-1" projectId="proj-1" onClose={vi.fn()} />);
    expect(screen.getByText('upload-zone-rendered')).toBeDefined();
  });

  it('disables the paste-text CTA until text is entered', () => {
    render(<AddSourceModal workspaceId="ws-1" projectId="proj-1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Paste text' }));
    expect(screen.getByRole('button', { name: /add source/i })).toBeDisabled();
  });

  it('posts pasted text to the from-text endpoint and closes on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const onClose = vi.fn();
    render(<AddSourceModal workspaceId="ws-1" projectId="proj-1" onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Paste text' }));
    fireEvent.change(screen.getByPlaceholderText(/paste a transcript/i), {
      target: { value: 'some backlog text' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add source/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/projects/proj-1/sources/from-text',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: undefined, text: 'some backlog text' }),
      }),
    );
  });

  it('shows a helpful empty state on the connector tab when nothing is connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ scopes: [] }) }),
    );
    render(<AddSourceModal workspaceId="ws-1" projectId="proj-1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pull from a tool' }));
    await waitFor(() => expect(screen.getByText(/no tools connected yet/i)).toBeDefined());
  });

  it('pulls a backlog from a connected scope on the connector tab', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('connector-scope')) {
          return {
            ok: true,
            json: async () => ({
              scopes: [
                {
                  connectionId: 'conn-1',
                  toolKey: 'jira',
                  scopeValue: 'PAY',
                  scopeLabel: 'Payments (PAY)',
                },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    const onClose = vi.fn();
    render(<AddSourceModal workspaceId="ws-1" projectId="proj-1" onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pull from a tool' }));
    await waitFor(() => expect(screen.getByRole('combobox')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /pull backlog/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/projects/proj-1/sources/from-connector',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tool: 'jira', remote: 'PAY' }),
      }),
    );
  });
});
