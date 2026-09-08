import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LandingPage } from './landing-page';

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

function renderLandingPage(remainingInvites: number | null = 12, totalInvites = 15) {
  return render(<LandingPage remainingInvites={remainingInvites} totalInvites={totalInvites} />);
}

describe('LandingPage', () => {
  it('renders the hero headline', () => {
    renderLandingPage();
    expect(screen.getByText('Approved work items out.')).toBeDefined();
  });

  it('renders a Request access button that opens the request-access modal', () => {
    renderLandingPage();
    const buttons = screen.getAllByRole('button', { name: /request access/i });
    expect(buttons.length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/work email/i)).toBeNull();
  });

  it('shows the invite-count badge when a count is provided', () => {
    renderLandingPage(7, 15);
    expect(screen.getByText('7 of 15 invites left')).toBeDefined();
  });

  it('renders no invite-count badge when the count is null', () => {
    renderLandingPage(null, 15);
    expect(screen.queryByText(/invites left/i)).toBeNull();
  });

  it('renders the stage stepper with all five stages', () => {
    renderLandingPage();
    expect(screen.getByText('Ingest sources')).toBeDefined();
    expect(screen.getByText('AI generation')).toBeDefined();
    expect(screen.getByText('Human review')).toBeDefined();
    expect(screen.getByText('Publish to tools')).toBeDefined();
    expect(screen.getByText('Audit & sync')).toBeDefined();
  });

  it('does not render a Reset button', () => {
    renderLandingPage();
    expect(screen.queryByRole('button', { name: /^reset$/i })).toBeNull();
  });

  it('renders footer legal placeholder links', () => {
    renderLandingPage();
    expect(screen.getByText('Terms & Conditions')).toBeDefined();
    expect(screen.getByText('Privacy Policy')).toBeDefined();
  });

  it('renders the run-demo CTA', () => {
    renderLandingPage();
    expect(screen.getByRole('button', { name: /run end-to-end demo/i })).toBeDefined();
  });
});
