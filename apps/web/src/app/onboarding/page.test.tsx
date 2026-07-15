import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OnboardingPage from './page';

const push = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

const signInMock = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

describe('OnboardingPage', () => {
  beforeEach(() => {
    signInMock.mockResolvedValue({ error: undefined });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ ok: true, workspaceId: 'ws-1' }) }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders step 1 of the signup form', () => {
    render(<OnboardingPage />);
    expect(screen.getByRole('heading', { name: /get started with specmate/i })).toBeDefined();
    expect(screen.getByLabelText(/full name/i)).toBeDefined();
    expect(screen.getByLabelText(/work email/i)).toBeDefined();
    expect(screen.getByLabelText(/^password$/i)).toBeDefined();
  });

  it('rejects a password shorter than 8 characters before advancing', () => {
    render(<OnboardingPage />);
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByText(/at least 8 characters/i)).toBeDefined();
    expect(screen.queryByLabelText(/workspace name/i)).toBeNull();
  });

  it('completes signup end-to-end: account step, workspace step, signs in, reaches plan selection', async () => {
    render(<OnboardingPage />);

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    const workspaceInput = screen.getByLabelText(/workspace name/i);
    fireEvent.change(workspaceInput, { target: { value: 'Acme Corp' } });
    fireEvent.click(screen.getByRole('button', { name: /create workspace/i }));

    // Issue 10.9: after workspace creation, the flow now lands on plan
    // selection (Starter/Enterprise) before the dashboard, not a direct redirect.
    await waitFor(() => expect(screen.getByText(/choose a plan/i)).toBeDefined());

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/signup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Jane Doe',
          email: 'jane@acme.com',
          password: 'password123',
          workspaceName: 'Acme Corp',
        }),
      }),
    );
    expect(signInMock).toHaveBeenCalledWith('credentials', {
      email: 'jane@acme.com',
      password: 'password123',
      redirect: false,
    });
  });

  it('skipping plan selection routes straight to the workspace dashboard', async () => {
    render(<OnboardingPage />);

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: 'Acme Corp' } });
    fireEvent.click(screen.getByRole('button', { name: /create workspace/i }));

    await waitFor(() => expect(screen.getByText(/choose a plan/i)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    expect(push).toHaveBeenCalledWith('/workspaces/ws-1');
  });

  it('choosing Enterprise sets the tier and routes to the workspace dashboard without Stripe', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/signup') {
        return { ok: true, json: async () => ({ ok: true, workspaceId: 'ws-1' }) };
      }
      if (typeof url === 'string' && url.includes('/billing/tier')) {
        return { ok: true, json: async () => ({ ok: true, tier: 'ENTERPRISE' }) };
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<OnboardingPage />);
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: 'Acme Corp' } });
    fireEvent.click(screen.getByRole('button', { name: /create workspace/i }));

    await waitFor(() => expect(screen.getByText(/choose a plan/i)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /contact sales/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/workspaces/ws-1'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/billing/tier',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows an error if the signup API call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, json: async () => ({ error: 'Email already in use.' }) }),
    );

    render(<OnboardingPage />);
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: 'Acme Corp' } });
    fireEvent.click(screen.getByRole('button', { name: /create workspace/i }));

    await waitFor(() => expect(screen.getByText('Email already in use.')).toBeDefined());
  });
});
