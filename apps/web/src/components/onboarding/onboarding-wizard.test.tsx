import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingWizard } from './onboarding-wizard';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

describe('OnboardingWizard', () => {
  beforeEach(() => {
    push.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the "N items drafted" done screen after a successful generate, not an immediate route change', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          run_id: 'run-1',
          reused_existing_run: false,
          stats: { item_count: 24 },
        }),
      }),
    );

    render(
      <OnboardingWizard
        workspaceId="ws-1"
        projectId="proj-1"
        projectName="Payments Portal"
        hasConnectedTool={false}
        hasSource
      />,
    );

    // hasSource=true skips straight to the 'upload' step per existing logic, so
    // advance to 'generate' via the Continue button, then trigger generation.
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /generate items/i }));

    await waitFor(() => expect(screen.getByText(/24 items drafted/i)).toBeDefined());
    expect(screen.getByText(/Payments Portal/)).toBeDefined();
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /go to review/i }));
    expect(push).toHaveBeenCalledWith('/workspaces/ws-1/projects/proj-1/review');
  });

  it('does not show the step indicator on the done screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          run_id: 'run-1',
          reused_existing_run: false,
          stats: { item_count: 1 },
        }),
      }),
    );

    render(
      <OnboardingWizard
        workspaceId="ws-1"
        projectId="proj-1"
        projectName="Payments Portal"
        hasConnectedTool={false}
        hasSource
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /generate items/i }));

    await waitFor(() => expect(screen.getByText(/1 item drafted/i)).toBeDefined());
    expect(screen.queryByText('Connect a tool')).toBeNull();
    expect(screen.queryByText('Upload a source')).toBeNull();
  });

  it('shows an error and stays on the generate step when generation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ detail: 'No fragments to generate from.' }),
      }),
    );

    render(
      <OnboardingWizard
        workspaceId="ws-1"
        projectId="proj-1"
        projectName="Payments Portal"
        hasConnectedTool={false}
        hasSource
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /generate items/i }));

    await waitFor(() => expect(screen.getByText('No fragments to generate from.')).toBeDefined());
    expect(screen.queryByText(/items drafted/i)).toBeNull();
  });
});
