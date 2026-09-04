'use client';

import { useEffect, useState } from 'react';

const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  'microsoft-entra-id': 'Microsoft',
};

interface ConnectedAccount {
  id: string;
  provider: string;
}

export function ConnectedAccounts({
  initialAccounts,
  hasPassword: initialHasPassword,
}: {
  initialAccounts: ConnectedAccount[];
  hasPassword: boolean;
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [hasPassword, setHasPassword] = useState(initialHasPassword);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Refetch on window focus so a second tab's stale state (e.g. it still
  // thinks 2 accounts are linked after this account was unlinked elsewhere)
  // gets corrected before the reviewer can click an unlink button that the
  // server would now reject — the 409 is still the actual safety net (a
  // Serializable transaction), this just keeps the UI from lagging behind it.
  useEffect(() => {
    async function refresh() {
      const res = await fetch('/api/account/connections');
      if (!res.ok) return;
      const body: { accounts?: ConnectedAccount[]; hasPassword?: boolean } = await res
        .json()
        .catch(() => ({}));
      if (body.accounts) setAccounts(body.accounts);
      if (typeof body.hasPassword === 'boolean') setHasPassword(body.hasPassword);
    }
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  async function unlink(accountId: string) {
    setError(null);
    setRemovingId(accountId);
    const res = await fetch(`/api/account/connections/${accountId}`, { method: 'DELETE' });
    setRemovingId(null);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not remove this connection.');
      return;
    }
    setAccounts((prev) => prev.filter((a) => a.id !== accountId));
  }

  const onlySignInMethod = !hasPassword && accounts.length <= 1;

  return (
    <div className="rounded-lg border border-line bg-panel p-8">
      <div className="text-sm font-semibold text-ink">Connected accounts</div>
      {accounts.length === 0 ? (
        <p className="mt-3 text-sm text-sub">No providers linked yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between rounded border border-line px-4 py-3"
            >
              <span className="text-sm text-ink">
                {PROVIDER_LABELS[account.provider] ?? account.provider}
              </span>
              <button
                type="button"
                disabled={removingId === account.id || onlySignInMethod}
                onClick={() => void unlink(account.id)}
                className="text-sm font-semibold text-red disabled:opacity-50"
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-sm text-sub">
        To connect a new provider, sign out and sign back in with that provider using the same email
        address.
      </p>
      {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}
      {onlySignInMethod ? (
        <p className="mt-3 rounded border border-amber bg-amber-soft p-3 text-sm text-amber">
          This is your only sign-in method — you can&apos;t unlink it.
        </p>
      ) : null}
    </div>
  );
}
