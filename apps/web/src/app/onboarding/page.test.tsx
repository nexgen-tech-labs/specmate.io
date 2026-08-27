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

function fillAccountStep() {
  fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.com' } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}

function fillOrganizationStep(orgName = 'Acme Corp') {
  const orgNameInput = screen.getByLabelText(/organization name/i);
  fireEvent.change(orgNameInput, { target: { value: orgName } });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
}

function submitWorkspaceStep(workspaceName = 'Engineering') {
  fireEvent.change(screen.getByLabelText(/workspace name/i), {
    target: { value: workspaceName },
  });
  fireEvent.click(screen.getByRole('button', { name: /enter workspace/i }));
}

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
    expect(screen.getByText(/step 1 of 3/i)).toBeDefined();
  });

  it('rejects a password shorter than 8 characters before advancing', () => {
    render(<OnboardingPage />);
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'jane@acme.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByText(/at least 8 characters/i)).toBeDefined();
    expect(screen.queryByLabelText(/organization name/i)).toBeNull();
  });

  it('advances through account -> organization -> workspace, defaulting the org name', () => {
    render(<OnboardingPage />);
    fillAccountStep();

    expect(screen.getByText(/step 2 of 3/i)).toBeDefined();
    // Default org name suggestion derived from the first name, matching the mockup.
    expect(screen.getByLabelText(/organization name/i)).toHaveProperty('value', "Jane's Company");
    expect(screen.getByLabelText(/company size/i)).toBeDefined();

    fillOrganizationStep('Acme Corp');
    expect(screen.getByText(/step 3 of 3/i)).toBeDefined();
    expect(screen.getByText(/Acme Corp/)).toBeDefined();
  });

  it('back navigation returns to the previous step without losing entered data', () => {
    render(<OnboardingPage />);
    fillAccountStep();
    fireEvent.change(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme Corp' },
    });
    fireEvent.click(screen.getByRole('button', { name: /back/i }));

    expect(screen.getByText(/step 1 of 3/i)).toBeDefined();
    expect(screen.getByLabelText(/full name/i)).toHaveProperty('value', 'Jane Doe');
  });

  it('shows a provisioning spinner immediately after submitting the workspace step', () => {
    render(<OnboardingPage />);
    fillAccountStep();
    fillOrganizationStep('Acme Corp');
    submitWorkspaceStep('Engineering');

    expect(screen.getByText(/creating acme corp \/ engineering/i)).toBeDefined();
  });

  it('completes signup end-to-end with org and workspace (no team step), signs in, redirects to the dashboard', async () => {
    render(<OnboardingPage />);
    fillAccountStep();
    fillOrganizationStep('Acme Corp');
    submitWorkspaceStep('Engineering');

    await waitFor(() => expect(push).toHaveBeenCalledWith('/workspaces/ws-1'));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/signup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Jane Doe',
          email: 'jane@acme.com',
          password: 'password123',
          orgName: 'Acme Corp',
          orgSize: 'SOLO',
          workspaceName: 'Engineering',
        }),
      }),
    );
    expect(signInMock).toHaveBeenCalledWith('credentials', {
      email: 'jane@acme.com',
      password: 'password123',
      redirect: false,
    });
  });

  it('shows an error and returns to the workspace step if the signup API call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, json: async () => ({ error: 'Email already in use.' }) }),
    );

    render(<OnboardingPage />);
    fillAccountStep();
    fillOrganizationStep('Acme Corp');
    submitWorkspaceStep('Engineering');

    await waitFor(() => expect(screen.getByText('Email already in use.')).toBeDefined());
    // Back on the workspace form, not stuck on the spinner.
    expect(screen.getByLabelText(/workspace name/i)).toBeDefined();
  });
});
