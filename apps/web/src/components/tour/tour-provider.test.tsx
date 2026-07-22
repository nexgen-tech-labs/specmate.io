import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TourProvider, useTour } from './tour-provider';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(mockSearch),
  usePathname: () => '/workspaces/ws1/projects/p1/get-started',
}));

let mockSearch = '';

function TestConsumer() {
  const { activeStepId, startTour, nextStep, skipTour, wizardAdvanceSignal, syncWizardStep } =
    useTour();
  return (
    <div>
      <span data-testid="active-step">{activeStepId ?? 'none'}</span>
      <span data-testid="wizard-advance-signal">{wizardAdvanceSignal}</span>
      <button onClick={startTour}>start</button>
      <button onClick={nextStep}>next</button>
      <button onClick={skipTour}>skip</button>
      <button onClick={() => syncWizardStep('upload')}>sync-upload</button>
      <button onClick={() => syncWizardStep('done')}>sync-done</button>
    </div>
  );
}

describe('TourProvider', () => {
  beforeEach(() => {
    pushMock.mockClear();
    mockSearch = '';
    sessionStorage.clear();
  });

  it('starts with no active step', () => {
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    expect(screen.getByTestId('active-step').textContent).toBe('none');
  });

  it('startTour sets the first step and persists it to sessionStorage', () => {
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('start'));
    });
    expect(screen.getByTestId('active-step').textContent).toBe('dashboard-start');
    expect(sessionStorage.getItem('specmate_tour_step')).toBe('dashboard-start');
  });

  it('nextStep advances to the following step and navigates when the page changes', () => {
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('start'));
    });
    act(() => {
      fireEvent.click(screen.getByText('next'));
    });
    expect(screen.getByTestId('active-step').textContent).toBe('wizard-connect');
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('?tour=wizard-connect'));
  });

  it('skipTour clears the active step and sessionStorage', () => {
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('start'));
    });
    act(() => {
      fireEvent.click(screen.getByText('skip'));
    });
    expect(screen.getByTestId('active-step').textContent).toBe('none');
    expect(sessionStorage.getItem('specmate_tour_step')).toBeNull();
  });

  it('restores an in-progress step from the URL query param on mount', () => {
    mockSearch = 'tour=wizard-upload';
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    expect(screen.getByTestId('active-step').textContent).toBe('wizard-upload');
  });

  it('skipTour strips the ?tour= query param from the URL', () => {
    mockSearch = 'tour=wizard-upload';
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('skip'));
    });
    // pathname mock has no query string, so skipTour navigating to it strips ?tour=.
    expect(pushMock).toHaveBeenCalledWith('/workspaces/ws1/projects/p1/get-started');
  });

  it('nextStep bumps wizardAdvanceSignal instead of advancing activeStepId when a wizard step is active', () => {
    mockSearch = 'tour=wizard-connect';
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    expect(screen.getByTestId('active-step').textContent).toBe('wizard-connect');
    expect(screen.getByTestId('wizard-advance-signal').textContent).toBe('0');

    act(() => {
      fireEvent.click(screen.getByText('next'));
    });

    // activeStepId does NOT change -- the wizard's own onStepChange (via
    // syncWizardStep) is what's supposed to move it forward, not nextStep.
    expect(screen.getByTestId('active-step').textContent).toBe('wizard-connect');
    expect(screen.getByTestId('wizard-advance-signal').textContent).toBe('1');
  });

  it('nextStep still advances activeStepId immediately for non-wizard steps', () => {
    mockSearch = 'tour=dashboard-start';
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('next'));
    });
    expect(screen.getByTestId('active-step').textContent).toBe('wizard-connect');
    expect(screen.getByTestId('wizard-advance-signal').textContent).toBe('0');
  });

  it('syncWizardStep advances activeStepId to the mapped tour step when a wizard step is active', () => {
    mockSearch = 'tour=wizard-connect';
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('sync-upload'));
    });
    expect(screen.getByTestId('active-step').textContent).toBe('wizard-upload');
    expect(sessionStorage.getItem('specmate_tour_step')).toBe('wizard-upload');
    // Same page (get-started) -> URL is kept in sync.
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining('?tour=wizard-upload'));
  });

  it('syncWizardStep maps the wizard reaching "done" to the review-approve tour step without navigating away', () => {
    mockSearch = 'tour=wizard-generate';
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    pushMock.mockClear();
    act(() => {
      fireEvent.click(screen.getByText('sync-done'));
    });
    expect(screen.getByTestId('active-step').textContent).toBe('review-approve');
    // review-approve lives on a different page (/review) -- syncWizardStep
    // must not auto-navigate there, since the wizard shows its own "done"
    // screen and the user clicks "Go to Review" themselves.
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('syncWizardStep is a no-op when no wizard tour step is active', () => {
    mockSearch = 'tour=dashboard-start';
    render(
      <TourProvider>
        <TestConsumer />
      </TourProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('sync-upload'));
    });
    expect(screen.getByTestId('active-step').textContent).toBe('dashboard-start');
  });
});
