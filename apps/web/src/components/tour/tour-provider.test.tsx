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
  const { activeStepId, startTour, nextStep, skipTour } = useTour();
  return (
    <div>
      <span data-testid="active-step">{activeStepId ?? 'none'}</span>
      <button onClick={startTour}>start</button>
      <button onClick={nextStep}>next</button>
      <button onClick={skipTour}>skip</button>
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
});
