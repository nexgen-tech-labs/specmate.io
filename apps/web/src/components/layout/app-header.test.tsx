import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

let currentSession: { user: { id: string; name?: string | null; email?: string | null } } | null =
  null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
  signOut: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { AppHeader } = await import('./app-header');

describe('AppHeader', () => {
  it('shows a Sign In button (opens a modal) and a Get Started link when signed out', async () => {
    currentSession = null;
    render(await AppHeader());

    expect(screen.getByRole('button', { name: /sign in/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /get started/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  it("Get Started links to the homepage's request-access flow, not /onboarding", async () => {
    currentSession = null;
    render(await AppHeader());

    expect(screen.getByRole('link', { name: /get started/i })).toHaveAttribute(
      'href',
      '/?request-access=1',
    );
  });

  it('shows the account link and Sign Out when signed in, not Sign In/Get Started', async () => {
    currentSession = { user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' } };
    render(await AppHeader());

    expect(screen.getByRole('link', { name: 'Ada Lovelace' })).toBeDefined();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /get started/i })).toBeNull();
  });

  it('always renders the SpecMate logo', async () => {
    currentSession = null;
    render(await AppHeader());
    expect(screen.getByText('SpecMate')).toBeDefined();
  });
});
