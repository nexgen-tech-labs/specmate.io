import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InviteModal } from './invite-modal';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

describe('InviteModal', () => {
  beforeEach(() => {
    refresh.mockClear();
    vi.unstubAllGlobals();
  });

  it('disables the send button until at least one email is added', () => {
    render(<InviteModal workspaceId="ws-1" onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /send invite/i })).toBeDisabled();
  });

  it('adds an email as a chip and enables sending, then posts one request per email', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<InviteModal workspaceId="ws-1" onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('name@company.com'), {
      target: { value: 'a@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('a@example.com')).toBeDefined();

    const sendButton = screen.getByRole('button', { name: /send invite/i });
    expect(sendButton).not.toBeDisabled();
    fireEvent.click(sendButton);

    await waitFor(() => expect(screen.getByText(/invites sent/i)).toBeDefined());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/invites',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'a@example.com', role: 'REVIEWER' }),
      }),
    );
  });

  it('reports partial failure without losing the emails that succeeded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { email: string };
        return { ok: body.email !== 'bad@example.com' };
      }),
    );
    render(<InviteModal workspaceId="ws-1" onClose={vi.fn()} />);

    for (const email of ['good@example.com', 'bad@example.com']) {
      fireEvent.change(screen.getByPlaceholderText('name@company.com'), {
        target: { value: email },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    }

    fireEvent.click(screen.getByRole('button', { name: /send invites/i }));

    await waitFor(() => expect(screen.getByText(/1 invite failed to send/i)).toBeDefined());
  });
});
