import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TakeTourButton } from './take-tour-button';

const startTourMock = vi.fn();
vi.mock('./tour-provider', () => ({
  useTour: () => ({ startTour: startTourMock }),
}));

describe('TakeTourButton', () => {
  it('renders a button that calls startTour on click', () => {
    render(<TakeTourButton />);
    fireEvent.click(screen.getByText('Take a tour'));
    expect(startTourMock).toHaveBeenCalledOnce();
  });
});
