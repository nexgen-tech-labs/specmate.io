import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LandingPage } from './landing-page';

vi.mock('next-auth/react', () => ({ signIn: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('LandingPage', () => {
  it('renders the hero headline', () => {
    render(<LandingPage />);
    expect(screen.getByText('Approved work items out.')).toBeDefined();
  });

  it('renders a Get Started link pointing to /onboarding', () => {
    render(<LandingPage />);
    const links = screen.getAllByRole('link', { name: /get started/i });
    expect(links.length).toBeGreaterThan(0);
    links.forEach((link) => expect(link.getAttribute('href')).toBe('/onboarding'));
  });

  it('renders the stage stepper with all five stages', () => {
    render(<LandingPage />);
    expect(screen.getByText('Ingest sources')).toBeDefined();
    expect(screen.getByText('AI generation')).toBeDefined();
    expect(screen.getByText('Human review')).toBeDefined();
    expect(screen.getByText('Publish to tools')).toBeDefined();
    expect(screen.getByText('Audit & sync')).toBeDefined();
  });

  it('does not render a Reset button', () => {
    render(<LandingPage />);
    expect(screen.queryByRole('button', { name: /^reset$/i })).toBeNull();
  });

  it('renders footer legal placeholder links', () => {
    render(<LandingPage />);
    expect(screen.getByText('Terms & Conditions')).toBeDefined();
    expect(screen.getByText('Privacy Policy')).toBeDefined();
  });

  it('opens the Sign In modal with OAuth options and a back-to-home action', () => {
    render(<LandingPage />);
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(screen.getByText('Sign in to your workspace')).toBeDefined();
    expect(screen.getByText('Continue with Google')).toBeDefined();
    expect(screen.getByText('Continue with Microsoft')).toBeDefined();
    expect(screen.getByText('Continue with GitHub')).toBeDefined();
    expect(screen.getByText('Continue with Jira')).toBeDefined();
    expect(screen.getByRole('button', { name: /back to home/i })).toBeDefined();
  });

  it('toggles the Sign In modal to create-account framing', () => {
    render(<LandingPage />);
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    fireEvent.click(screen.getByText('Get started'));

    expect(screen.getByText('Create your workspace')).toBeDefined();
  });

  it('closes the Sign In modal via Back to Home', () => {
    render(<LandingPage />);
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    fireEvent.click(screen.getByRole('button', { name: /back to home/i }));

    expect(screen.queryByText('Sign in to your workspace')).toBeNull();
  });
});
