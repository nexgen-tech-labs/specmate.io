'use client';

import { useState } from 'react';

export function AcceptInviteButton({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  if (accepted) {
    return <p className="mt-5 font-semibold text-green">You&apos;ve joined the workspace ✓</p>;
  }

  return (
    <div className="mt-5">
      <button
        onClick={async () => {
          setSubmitting(true);
          setError(null);
          const res = await fetch(`/api/invites/${token}/accept`, { method: 'POST' });
          if (!res.ok) {
            const body: { error?: string } = await res.json();
            setError(body.error ?? 'Could not accept this invite.');
            setSubmitting(false);
            return;
          }
          setAccepted(true);
        }}
        disabled={submitting}
        className="w-full rounded-md bg-cobalt px-5 py-3 text-base font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
      >
        {submitting ? 'Joining…' : 'Accept invite →'}
      </button>
      {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}
    </div>
  );
}
