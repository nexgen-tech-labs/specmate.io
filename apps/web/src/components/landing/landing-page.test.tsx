import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LandingPage } from './landing-page';

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
});
