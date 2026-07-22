import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TourOverlay } from './tour-overlay';

const mockUseTour = vi.fn();
vi.mock('./tour-provider', () => ({
  useTour: () => mockUseTour(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/workspaces/ws1/projects/p1/get-started',
}));

function addTourTarget(targetId: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-tour', targetId);
  el.textContent = 'target';
  document.body.appendChild(el);
  return el;
}

describe('TourOverlay', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('renders nothing when no tour is active', () => {
    mockUseTour.mockReturnValue({ activeStepId: null, nextStep: vi.fn(), skipTour: vi.fn() });
    const { container } = render(<TourOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the active step targets a different page than the current route', () => {
    mockUseTour.mockReturnValue({
      activeStepId: 'review-approve', // page: 'review', current pathname ends in get-started
      nextStep: vi.fn(),
      skipTour: vi.fn(),
    });
    const { container } = render(<TourOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the tooltip with the step title/body when the target element exists on the current page', () => {
    mockUseTour.mockReturnValue({
      activeStepId: 'wizard-connect',
      nextStep: vi.fn(),
      skipTour: vi.fn(),
    });
    addTourTarget('wizard-step-connect');
    render(<TourOverlay />);
    expect(screen.getByText('Connect a tool (optional)')).toBeTruthy();
  });

  it('renders nothing when the step is unknown or its target element is not found in the DOM', () => {
    mockUseTour.mockReturnValue({
      activeStepId: 'wizard-connect',
      nextStep: vi.fn(),
      skipTour: vi.fn(),
    });
    // No matching data-tour element added — target genuinely absent.
    const { container } = render(<TourOverlay />);
    expect(container).toBeEmptyDOMElement();
  });
});
