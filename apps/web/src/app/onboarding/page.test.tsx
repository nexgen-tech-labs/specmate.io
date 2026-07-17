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

function fillWorkspaceStep(workspaceName = 'Engineering') {
  fireEvent.change(screen.getByLabelText(/workspace name/i), {
    target: { value: workspaceName },
  });
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
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
    expect(screen.getByText(/step 1 of 4/i)).toBeDefined();
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

    expect(screen.getByText(/step 2 of 4/i)).toBeDefined();
    // Default org name suggestion derived from the first name, matching the mockup.
    expect(screen.getByLabelText(/organization name/i)).toHaveProperty('value', "Jane's Company");
    expect(screen.getByLabelText(/company size/i)).toBeDefined();

    fillOrganizationStep('Acme Corp');
    expect(screen.getByText(/step 3 of 4/i)).toBeDefined();
    expect(screen.getByText(/Acme Corp/)).toBeDefined();
  });

  it('back navigation returns to the previous step without losing entered data', () => {
    render(<OnboardingPage />);
    fillAccountStep();
    fireEvent.change(screen.getByLabelText(/organization name/i), {
      target: { value: 'Acme Corp' },
    });
    fireEvent.click(screen.getByRole('button', { name: /back/i }));

    expect(screen.getByText(/step 1 of 4/i)).toBeDefined();
    expect(screen.getByLabelText(/full name/i)).toHaveProperty('value', 'Jane Doe');
  });

  it('team step: adds and removes email chips', () => {
    render(<OnboardingPage />);
    fillAccountStep();
    fillOrganizationStep();
    fillWorkspaceStep();

    expect(screen.getByText(/step 4 of 4/i)).toBeDefined();

    const emailInput = screen.getByPlaceholderText(/teammate@company.com/i);
    fireEvent.change(emailInput, { target: { value: 'bob@acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(screen.getByText('bob@acme.com')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /remove bob@acme.com/i }));
    expect(screen.queryByText('bob@acme.com')).toBeNull();
  });

  it('team step: Enter key adds an email chip', () => {
    render(<OnboardingPage />);
    fillAccountStep();
    fillOrganizationStep();
    fillWorkspaceStep();

    const emailInput = screen.getByPlaceholderText(/teammate@company.com/i);
    fireEvent.change(emailInput, { target: { value: 'carol@acme.com' } });
    fireEvent.keyDown(emailInput, { key: 'Enter' });

    expect(screen.getByText('carol@acme.com')).toBeDefined();
  });

  it('completes signup end-to-end with org, workspace, and team invites, signs in, redirects to the dashboard', async () => {
    render(<OnboardingPage />);
    fillAccountStep();
    fillOrganizationStep('Acme Corp');
    fillWorkspaceStep('Engineering');

    const emailInput = screen.getByPlaceholderText(/teammate@company.com/i);
    fireEvent.change(emailInput, { target: { value: 'bob@acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    fireEvent.click(screen.getByRole('button', { name: /create workspace/i }));

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
          teamEmails: ['bob@acme.com'],
        }),
      }),
    );
    expect(signInMock).toHaveBeenCalledWith('credentials', {
      email: 'jane@acme.com',
      password: 'password123',
      redirect: false,
    });
  });

  it('"Skip for now" completes signup with no team invites', async () => {
    render(<OnboardingPage />);
    fillAccountStep();
    fillOrganizationStep('Acme Corp');
    fillWorkspaceStep('Engineering');

    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/workspaces/ws-1'));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/signup',
      expect.objectContaining({
        body: expect.stringContaining('"teamEmails":[]') as string,
      }),
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
    fillAccountStep();
    fillOrganizationStep('Acme Corp');
    fillWorkspaceStep('Engineering');
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    await waitFor(() => expect(screen.getByText('Email already in use.')).toBeDefined());
  });
});
