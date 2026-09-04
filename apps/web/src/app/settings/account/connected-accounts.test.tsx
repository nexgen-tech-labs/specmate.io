import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConnectedAccounts } from './connected-accounts';

describe('ConnectedAccounts', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('disables Unlink and shows the warning when it is the only sign-in method', () => {
    render(
      <ConnectedAccounts
        initialAccounts={[{ id: 'a1', provider: 'github' }]}
        hasPassword={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeDisabled();
    expect(screen.getByText(/only sign-in method/)).toBeInTheDocument();
  });

  it('enables Unlink when a password exists even with one account', () => {
    render(
      <ConnectedAccounts initialAccounts={[{ id: 'a1', provider: 'github' }]} hasPassword={true} />,
    );
    expect(screen.getByRole('button', { name: 'Unlink' })).not.toBeDisabled();
  });

  it('removes the account from the list on a successful unlink', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    render(
      <ConnectedAccounts
        initialAccounts={[
          { id: 'a1', provider: 'github' },
          { id: 'a2', provider: 'google' },
        ]}
        hasPassword={false}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[0]);

    await waitFor(() => expect(screen.queryByText('GitHub')).not.toBeInTheDocument());
    expect(screen.getByText('Google')).toBeInTheDocument();
  });

  it('shows the server error and does not remove the account on a 409', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'This is your only sign-in method...' }),
      }),
    );
    render(
      <ConnectedAccounts
        initialAccounts={[
          { id: 'a1', provider: 'github' },
          { id: 'a2', provider: 'google' },
        ]}
        hasPassword={false}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[0]);

    await waitFor(() =>
      expect(screen.getByText('This is your only sign-in method...')).toBeInTheDocument(),
    );
    expect(screen.getByText('GitHub')).toBeInTheDocument();
  });

  it('refetches and corrects state on window focus (fixes multi-tab staleness, Issue #112)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accounts: [{ id: 'a2', provider: 'google' }], hasPassword: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ConnectedAccounts
        initialAccounts={[
          { id: 'a1', provider: 'github' },
          { id: 'a2', provider: 'google' },
        ]}
        hasPassword={false}
      />,
    );

    // Initially both accounts show and Unlink is enabled (2 accounts, no password).
    expect(screen.getAllByRole('button', { name: 'Unlink' })[0]).not.toBeDisabled();

    fireEvent(window, new Event('focus'));

    // After the (simulated) other-tab unlink is picked up, only Google remains
    // and the sole remaining account's Unlink button is now disabled.
    await waitFor(() => expect(screen.queryByText('GitHub')).not.toBeInTheDocument());
    expect(screen.getByText('Google')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith('/api/account/connections');
  });

  it('does not update state when the focus refetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    render(
      <ConnectedAccounts initialAccounts={[{ id: 'a1', provider: 'github' }]} hasPassword={true} />,
    );

    fireEvent(window, new Event('focus'));

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText('GitHub')).toBeInTheDocument();
  });
});
