import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AtlassianConnectClaim } from './atlassian-connect-claim';

const routerRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

const unclaimedInstall = {
  id: 'install-1',
  baseUrl: 'https://acme.atlassian.net',
  displayUrl: 'acme.atlassian.net',
  installedAt: '2026-09-01T00:00:00.000Z',
};

const claimedInstall = {
  id: 'install-2',
  baseUrl: 'https://linked.atlassian.net',
  displayUrl: null,
  installedAt: '2026-08-01T00:00:00.000Z',
};

describe('AtlassianConnectClaim', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    routerRefresh.mockClear();
  });

  it('shows a message when no Jira site is linked yet', () => {
    render(<AtlassianConnectClaim workspaceId="ws-1" initialClaimed={[]} initialUnclaimed={[]} />);
    expect(screen.getByText(/no jira site is linked/i)).toBeInTheDocument();
    expect(screen.getByText(/no unclaimed installs/i)).toBeInTheDocument();
  });

  it('lists a linked Jira site', () => {
    render(
      <AtlassianConnectClaim
        workspaceId="ws-1"
        initialClaimed={[claimedInstall]}
        initialUnclaimed={[]}
      />,
    );
    expect(screen.getByText('https://linked.atlassian.net')).toBeInTheDocument();
  });

  it('claims an unclaimed install and refreshes on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <AtlassianConnectClaim
        workspaceId="ws-1"
        initialClaimed={[]}
        initialUnclaimed={[unclaimedInstall]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /claim/i }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/atlassian-connect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ installId: 'install-1' }),
      }),
    );
  });

  it('shows the server error inline when claiming fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'This install is already claimed by a different workspace.' }),
      }),
    );
    render(
      <AtlassianConnectClaim
        workspaceId="ws-1"
        initialClaimed={[]}
        initialUnclaimed={[unclaimedInstall]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /claim/i }));

    await waitFor(() =>
      expect(
        screen.getByText('This install is already claimed by a different workspace.'),
      ).toBeInTheDocument(),
    );
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
