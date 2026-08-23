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

  it('does not render a Reset button', () => {
    render(<LandingPage />);
    expect(screen.queryByRole('button', { name: /^reset$/i })).toBeNull();
  });

  it('renders footer legal placeholder links', () => {
    render(<LandingPage />);
    expect(screen.getByText('Terms & Conditions')).toBeDefined();
    expect(screen.getByText('Privacy Policy')).toBeDefined();
  });

  it('renders the run-demo CTA', () => {
    render(<LandingPage />);
    expect(screen.getByRole('button', { name: /run end-to-end demo/i })).toBeDefined();
  });
});
