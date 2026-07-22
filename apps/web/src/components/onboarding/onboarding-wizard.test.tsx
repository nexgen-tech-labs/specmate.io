import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingWizard } from './onboarding-wizard';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

// OnboardingWizard calls useTour() internally (it's always safely callable
// since TourProvider is mounted globally in the root layout — see
// tour-provider.tsx). Stub it here so the wizard's default non-tour tests
// don't need a real TourProvider; tests that care about tour wiring pass
// onStepChange/tourAdvanceSignal props explicitly, which take precedence
// over the (stubbed, inert) context values.
const syncWizardStepMock = vi.fn();
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ syncWizardStep: syncWizardStepMock, wizardAdvanceSignal: 0 }),
}));

describe('OnboardingWizard', () => {
  beforeEach(() => {
    push.mockClear();
    syncWizardStepMock.mockClear();
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

  describe('tour wiring (Bug 1: tour/wizard step state sync)', () => {
    it('calls onStepChange with the real starting step on mount, including when it is not "connect"', () => {
      const onStepChange = vi.fn();
      render(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource // starts on 'upload', not 'connect', per existing skip logic
          onStepChange={onStepChange}
        />,
      );
      expect(onStepChange).toHaveBeenCalledWith('upload');
      expect(onStepChange).toHaveBeenCalledTimes(1);
    });

    it('calls onStepChange with "connect" on mount when neither a tool nor a source exists yet', () => {
      const onStepChange = vi.fn();
      render(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource={false}
          onStepChange={onStepChange}
        />,
      );
      expect(onStepChange).toHaveBeenCalledWith('connect');
    });

    it('calls onStepChange again every time the internal step changes', () => {
      const onStepChange = vi.fn();
      render(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource={false}
          onStepChange={onStepChange}
        />,
      );
      onStepChange.mockClear();
      fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));
      expect(onStepChange).toHaveBeenCalledWith('upload');
    });

    it('incrementing tourAdvanceSignal on the "connect" step performs the same action as "Skip for now"', () => {
      const onStepChange = vi.fn();
      const { rerender } = render(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource={false}
          onStepChange={onStepChange}
          tourAdvanceSignal={0}
        />,
      );
      expect(screen.getByText('Connect a tool (optional)')).toBeDefined();

      rerender(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource={false}
          onStepChange={onStepChange}
          tourAdvanceSignal={1}
        />,
      );

      expect(document.querySelector('[data-tour="wizard-step-upload"]')).not.toBeNull();
    });

    it('incrementing tourAdvanceSignal on "upload" does nothing while canGenerate is false (no source uploaded yet)', () => {
      const onStepChange = vi.fn();
      const { rerender } = render(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource={false} // canGenerate stays false until a source is uploaded/parsed
          onStepChange={onStepChange}
          tourAdvanceSignal={0}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));
      expect(document.querySelector('[data-tour="wizard-step-upload"]')).not.toBeNull();

      rerender(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource={false}
          onStepChange={onStepChange}
          tourAdvanceSignal={1}
        />,
      );

      // Still on the upload step -- there's no safe programmatic action when
      // the user hasn't actually uploaded anything themselves.
      expect(document.querySelector('[data-tour="wizard-step-upload"]')).not.toBeNull();
    });

    it('incrementing tourAdvanceSignal on "upload" advances to "generate" once canGenerate is true', () => {
      const onStepChange = vi.fn();
      const { rerender } = render(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource // parseStatus starts 'PARSED' -> canGenerate is already true
          onStepChange={onStepChange}
          tourAdvanceSignal={0}
        />,
      );
      expect(document.querySelector('[data-tour="wizard-step-upload"]')).not.toBeNull();

      rerender(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource
          onStepChange={onStepChange}
          tourAdvanceSignal={1}
        />,
      );

      expect(document.querySelector('[data-tour="wizard-step-generate"]')).not.toBeNull();
    });

    it('incrementing tourAdvanceSignal on "generate" triggers a real generate call, same as the button', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            run_id: 'run-1',
            reused_existing_run: false,
            stats: { item_count: 7 },
          }),
        }),
      );
      const onStepChange = vi.fn();
      const { rerender } = render(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource
          onStepChange={onStepChange}
          tourAdvanceSignal={0}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));
      expect(document.querySelector('[data-tour="wizard-step-generate"]')).not.toBeNull();

      rerender(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource
          onStepChange={onStepChange}
          tourAdvanceSignal={1}
        />,
      );

      await waitFor(() => expect(screen.getByText(/7 items drafted/i)).toBeDefined());
    });

    it('does not re-trigger the primary action on re-render when tourAdvanceSignal is unchanged', () => {
      const onStepChange = vi.fn();
      const { rerender } = render(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource={false}
          onStepChange={onStepChange}
          tourAdvanceSignal={1}
        />,
      );
      expect(document.querySelector('[data-tour="wizard-step-connect"]')).not.toBeNull();

      // Re-render with the SAME signal value -- should not re-fire the skip action.
      rerender(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource={false}
          onStepChange={onStepChange}
          tourAdvanceSignal={1}
        />,
      );

      expect(document.querySelector('[data-tour="wizard-step-connect"]')).not.toBeNull();
    });

    it('falls back to the tour context (useTour) when onStepChange/tourAdvanceSignal props are not provided', () => {
      render(
        <OnboardingWizard
          workspaceId="ws-1"
          projectId="proj-1"
          projectName="Payments Portal"
          hasConnectedTool={false}
          hasSource={false}
        />,
      );
      // Mounts fine without throwing (useTour() is always callable), and
      // reports its starting step via the tour's syncWizardStep by default.
      expect(syncWizardStepMock).toHaveBeenCalledWith('connect');
    });
  });
});
