import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GitHubAppClaim } from './github-app-claim';

const routerRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

const unclaimedInstall = {
  id: 'install-1',
  accountLogin: 'unclaimed-org',
  accountType: 'Organization',
  repositorySelection: 'all',
  installedAt: '2026-09-01T00:00:00.000Z',
};

const claimedInstall = {
  id: 'install-2',
  accountLogin: 'linked-org',
  accountType: 'Organization',
  repositorySelection: 'selected',
  installedAt: '2026-08-01T00:00:00.000Z',
};

describe('GitHubAppClaim', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    routerRefresh.mockClear();
  });

  it('shows a message when no GitHub account is linked yet', () => {
    render(<GitHubAppClaim workspaceId="ws-1" initialClaimed={[]} initialUnclaimed={[]} />);
    expect(screen.getByText(/no github account is linked/i)).toBeInTheDocument();
    expect(screen.getByText(/no unclaimed installs/i)).toBeInTheDocument();
  });

  it('lists a linked GitHub account', () => {
    render(
      <GitHubAppClaim workspaceId="ws-1" initialClaimed={[claimedInstall]} initialUnclaimed={[]} />,
    );
    expect(screen.getByText('linked-org')).toBeInTheDocument();
    expect(screen.getByText('selected repos')).toBeInTheDocument();
  });

  it('claims an unclaimed install and refreshes on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <GitHubAppClaim
        workspaceId="ws-1"
        initialClaimed={[]}
        initialUnclaimed={[unclaimedInstall]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /claim/i }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/github-app',
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
      <GitHubAppClaim
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
