import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

let currentSession: { user: { id: string; name?: string | null; email?: string | null } } | null =
  null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
  signOut: vi.fn(),
}));

const { AppHeader } = await import('./app-header');

describe('AppHeader', () => {
  it('shows Sign In and Get Started when signed out', async () => {
    currentSession = null;
    render(await AppHeader());

    expect(screen.getByRole('link', { name: /sign in/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /get started/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
  });

  it('shows the account link and Sign Out when signed in, not Sign In/Get Started', async () => {
    currentSession = { user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' } };
    render(await AppHeader());

    expect(screen.getByRole('link', { name: 'Ada Lovelace' })).toBeDefined();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeDefined();
    expect(screen.queryByRole('link', { name: /^sign in$/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /get started/i })).toBeNull();
  });

  it('always renders the SpecMate logo', async () => {
    currentSession = null;
    render(await AppHeader());
    expect(screen.getByText('SpecMate')).toBeDefined();
  });
});
