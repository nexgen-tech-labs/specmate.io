'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Install {
  id: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  installedAt: string;
}

export function GitHubAppClaim({
  workspaceId,
  initialClaimed,
  initialUnclaimed,
}: {
  workspaceId: string;
  initialClaimed: Install[];
  initialUnclaimed: Install[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  async function claim(installId: string) {
    setError(null);
    setClaimingId(installId);
    const res = await fetch(`/api/workspaces/${workspaceId}/github-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId }),
    });
    setClaimingId(null);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not claim this install.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-sm font-semibold text-ink">Linked GitHub accounts</h2>
        {initialClaimed.length === 0 ? (
          <p className="mt-2 text-sm text-sub">
            No GitHub account is linked to this workspace yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-panel">
            {initialClaimed.map((install) => (
              <li key={install.id} className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-ink">
                  {install.accountLogin}
                  <span className="ml-2 font-mono text-xs text-sub">
                    {install.repositorySelection === 'all' ? 'all repos' : 'selected repos'}
                  </span>
                </span>
                <span className="font-mono text-xs text-sub">
                  installed {new Date(install.installedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold text-ink">Unclaimed Marketplace installs</h2>
        <p className="mt-1 text-sm text-sub">
          A GitHub admin installed SpecMate from the GitHub Marketplace but hasn&apos;t linked it to
          a workspace yet. Claim the account below if it belongs to your team.
        </p>
        {initialUnclaimed.length === 0 ? (
          <p className="mt-3 text-sm text-sub">No unclaimed installs are waiting.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-panel">
            {initialUnclaimed.map((install) => (
              <li key={install.id} className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-ink">{install.accountLogin}</span>
                <button
                  type="button"
                  disabled={claimingId === install.id}
                  onClick={() => void claim(install.id)}
                  className="rounded-md bg-cobalt px-3 py-1.5 font-mono text-xs font-semibold text-white disabled:opacity-50"
                >
                  {claimingId === install.id ? 'Claiming…' : 'Claim'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}
      </div>
    </div>
  );
}
