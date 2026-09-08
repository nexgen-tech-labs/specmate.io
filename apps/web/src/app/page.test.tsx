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

  it('includes Organization + SoftwareApplication JSON-LD for AI/search discovery', async () => {
    // Reads a fixed, developer-authored literal already embedded in page.tsx
    // via dangerouslySetInnerHTML — asserting on that static content, not
    // injecting or sanitizing anything here.
    currentSession = null;
    const result = await Home();
    type ScriptProps = { dangerouslySetInnerHTML?: { __html: string } };
    type Fragment = { props: { children: Array<{ type: string; props: ScriptProps }> } };
    const children = (result as Fragment).props.children;
    const script = children.find((c) => c?.type === 'script');
    expect(script?.props.dangerouslySetInnerHTML).toBeDefined();
    const html = script!.props.dangerouslySetInnerHTML!.__html;
    const data = JSON.parse(html);
    expect(data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ '@type': 'Organization', name: 'SpecMate' }),
        expect.objectContaining({ '@type': 'SoftwareApplication', name: 'SpecMate' }),
      ]),
    );
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
