'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';

export function SignupInviteForm({
  token,
  email,
  companyName,
}: {
  token: string;
  email: string;
  companyName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setError(null);
    setSubmitting(true);

    const res = await fetch(`/api/signup-invite/${token}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    if (!res.ok) {
      const body: { error?: string } = await res.json().catch(() => ({}));
      setError(body.error ?? 'Something went wrong finishing your signup.');
      setSubmitting(false);
      return;
    }
    const { workspaceId }: { workspaceId: string } = await res.json();

    const result = await signIn('credentials', { email, password, redirect: false });
    if (result?.error) {
      setError('Account created, but sign-in failed. Try logging in manually.');
      setSubmitting(false);
      return;
    }
    router.push(`/workspaces/${workspaceId}`);
    router.refresh();
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="rounded-lg border border-line bg-panel p-8"
    >
      {error ? <p className="mb-4 text-sm text-red">{error}</p> : null}

      <label className="mb-1.5 block text-sm font-semibold text-ink">Work email</label>
      <div className="mb-4 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-sub">
        {email}
      </div>

      <label className="mb-1.5 block text-sm font-semibold text-ink">Company</label>
      <div className="mb-4 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-sub">
        {companyName}
      </div>

      <label htmlFor="signup-invite-name" className="mb-1.5 block text-sm font-semibold text-ink">
        Full name
      </label>
      <input
        id="signup-invite-name"
        type="text"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Jane Doe"
        className="mb-4 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
      />

      <label
        htmlFor="signup-invite-password"
        className="mb-1.5 block text-sm font-semibold text-ink"
      >
        Password
      </label>
      <input
        id="signup-invite-password"
        type="password"
        required
        minLength={8}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="At least 8 characters"
        className="mb-6 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
      />

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-cobalt px-5 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {submitting ? 'Creating your workspace…' : 'Create account →'}
      </button>
    </form>
  );
}
