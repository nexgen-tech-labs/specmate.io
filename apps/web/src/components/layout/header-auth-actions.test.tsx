import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HeaderAuthActions } from './header-auth-actions';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));

describe('HeaderAuthActions', () => {
  beforeEach(() => {
    push.mockClear();
  });

  it('does not render the Sign In modal until the button is clicked', () => {
    render(<HeaderAuthActions />);
    expect(screen.queryByPlaceholderText('Work email')).not.toBeInTheDocument();
  });

  it('opens the Sign In modal in signin mode when Sign In is clicked', () => {
    render(<HeaderAuthActions />);
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(screen.getByPlaceholderText('Work email')).toBeInTheDocument();
    expect(screen.getByText('Sign in to your workspace')).toBeInTheDocument();
  });

  it('closes the modal and navigates home when Back to Home is clicked', () => {
    render(<HeaderAuthActions />);
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    fireEvent.click(screen.getByRole('button', { name: /back to home/i }));
    expect(push).toHaveBeenCalledWith('/');
    expect(screen.queryByPlaceholderText('Work email')).not.toBeInTheDocument();
  });

  it('links Get Started to the homepage request-access flow', () => {
    render(<HeaderAuthActions />);
    expect(screen.getByRole('link', { name: /get started/i })).toHaveAttribute(
      'href',
      '/?request-access=1',
    );
  });
});
