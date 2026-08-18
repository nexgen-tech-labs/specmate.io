import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SignInModal } from './sign-in-modal';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

const signIn = vi.fn();
vi.mock('next-auth/react', () => ({ signIn: (...args: unknown[]) => signIn(...args) }));

function renderModal() {
  return render(
    <SignInModal authMode="signin" onModeChange={vi.fn()} onClose={vi.fn()} onBackHome={vi.fn()} />,
  );
}

describe('SignInModal — credentials sign-in redirect (Issue: sign-in landed back on the static homepage)', () => {
  beforeEach(() => {
    push.mockClear();
    signIn.mockClear();
    vi.unstubAllGlobals();
  });

  it('redirects to the workspace GET /api/me/workspace resolves, not back to "/"', async () => {
    signIn.mockResolvedValue({ error: undefined });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ workspaceId: 'ws-123' }) }),
    );

    renderModal();
    fireEvent.change(screen.getByPlaceholderText('Work email'), {
      target: { value: 'demo@specmate.io' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'correct-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/workspaces/ws-123'));
    expect(push).not.toHaveBeenCalledWith('/');
  });

  it('redirects to /onboarding when the signed-in user has no workspace yet', async () => {
    signIn.mockResolvedValue({ error: undefined });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ workspaceId: null }) }),
    );

    renderModal();
    fireEvent.change(screen.getByPlaceholderText('Work email'), {
      target: { value: 'demo@specmate.io' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'correct-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/onboarding'));
  });

  it('shows an error and does not redirect when credentials are invalid', async () => {
    signIn.mockResolvedValue({ error: 'CredentialsSignin' });

    renderModal();
    fireEvent.change(screen.getByPlaceholderText('Work email'), {
      target: { value: 'demo@specmate.io' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(screen.getByText('Invalid email or password.')).toBeDefined());
    expect(push).not.toHaveBeenCalled();
  });
});
