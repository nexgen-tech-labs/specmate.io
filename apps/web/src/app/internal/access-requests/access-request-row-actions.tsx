'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function AccessRequestRowActions({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupUrl, setSignupUrl] = useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/access-requests/${id}/approve`, { method: 'POST' });
    setBusy(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not approve this request.');
      return;
    }
    const { signupUrl: url }: { signupUrl: string } = await res.json();
    setSignupUrl(url);
    router.refresh();
  }

  async function reject() {
    const reviewNote = window.prompt('Optional rejection note (internal only):') ?? undefined;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/access-requests/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewNote }),
    });
    setBusy(false);
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not reject this request.');
      return;
    }
    router.refresh();
  }

  if (signupUrl) {
    return (
      <div className="text-xs">
        <p className="font-semibold text-green">Approved.</p>
        <p className="mt-1 break-all font-mono text-sub">{signupUrl}</p>
        <p className="mt-1 text-sub">Copy this link and send it to the requester manually.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void approve()}
          className="rounded bg-cobalt px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void reject()}
          className="rounded border border-line px-3 py-1.5 text-xs text-red disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {error ? <p className="text-xs text-red">{error}</p> : null}
    </div>
  );
}
