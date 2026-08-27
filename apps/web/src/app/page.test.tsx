import { describe, expect, it, vi } from 'vitest';

let currentSession: { user: { id: string } } | null = null;
let primaryWorkspaceId: string | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

vi.mock('@/lib/workspace-context', () => ({
  getPrimaryWorkspaceIdForUser: async () => primaryWorkspaceId,
}));

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectMock(url),
}));

vi.mock('@/components/landing/landing-page', () => ({
  LandingPage: () => 'landing-page-rendered',
}));

const { default: Home } = await import('./page');

describe('Home (root page)', () => {
  it('renders the landing page when signed out', async () => {
    currentSession = null;
    const result = await Home();
    expect((result as { type: unknown }).type).toBeDefined();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('redirects to the workspace dashboard when signed in with a workspace', async () => {
    currentSession = { user: { id: 'u1' } };
    primaryWorkspaceId = 'ws-1';
    await expect(Home()).rejects.toThrow('REDIRECT:/workspaces/ws-1');
  });

  it('redirects to onboarding when signed in with no workspace yet', async () => {
    currentSession = { user: { id: 'u1' } };
    primaryWorkspaceId = null;
    await expect(Home()).rejects.toThrow('REDIRECT:/onboarding');
  });
});
