'use client';

import { useState } from 'react';

type Role = 'ADMIN' | 'REVIEWER' | 'VIEWER';

export function InviteForm({ workspaceId }: { workspaceId: string }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('REVIEWER');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  if (inviteUrl) {
    return (
      <div className="landing-rise rounded-lg border border-line bg-panel p-8 text-center">
        <div className="font-mono text-sm font-bold tracking-[0.06em] text-green">
          INVITE CREATED ✓
        </div>
        <p className="mt-4 text-base text-sub">Share this link with {email}:</p>
        <code className="mt-3 block break-all rounded-md bg-paper px-4 py-3 text-sm text-ink">
          {typeof window !== 'undefined' ? `${window.location.origin}${inviteUrl}` : inviteUrl}
        </code>
      </div>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSubmitting(true);
        const res = await fetch(`/api/workspaces/${workspaceId}/invites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, role }),
        });
        if (!res.ok) {
          const body: { error?: string } = await res.json();
          setError(body.error ?? 'Could not create invite.');
          setSubmitting(false);
          return;
        }
        const body: { inviteUrl: string } = await res.json();
        setInviteUrl(body.inviteUrl);
      }}
      className="rounded-lg border border-line bg-panel p-8"
    >
      <label htmlFor="email" className="mb-2 block text-base font-semibold text-ink">
        Email
      </label>
      <input
        id="email"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="teammate@company.com"
        className="mb-4 w-full rounded-md border border-line bg-paper px-4 py-3 text-base text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
      />

      <label htmlFor="role" className="mb-2 block text-base font-semibold text-ink">
        Role
      </label>
      <select
        id="role"
        value={role}
        onChange={(e) => setRole(e.target.value as Role)}
        className="w-full rounded-md border border-line bg-paper px-4 py-3 text-base text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
      >
        <option value="ADMIN">Admin</option>
        <option value="REVIEWER">Reviewer</option>
        <option value="VIEWER">Viewer</option>
      </select>

      {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}

      <button
        type="submit"
        disabled={submitting}
        className="mt-5 w-full rounded-md bg-cobalt px-5 py-3 text-base font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
      >
        {submitting ? 'Creating invite…' : 'Create invite →'}
      </button>
    </form>
  );
}
