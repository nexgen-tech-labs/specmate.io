'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';

type Step = 'account' | 'workspace';

export function OnboardingForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('account');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (step === 'account') {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (password.length < 8) {
            setError('Password must be at least 8 characters.');
            return;
          }
          setStep('workspace');
        }}
        className="rounded-lg border border-line bg-panel p-8"
      >
        <div className="mb-4 font-mono text-sm text-sub">STEP 1 OF 2 — YOUR ACCOUNT</div>

        <label htmlFor="name" className="mb-2 block text-base font-semibold text-ink">
          Full name
        </label>
        <input
          id="name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
          className="mb-4 w-full rounded-md border border-line bg-paper px-4 py-3 text-base text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
        />

        <label htmlFor="email" className="mb-2 block text-base font-semibold text-ink">
          Work email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="mb-4 w-full rounded-md border border-line bg-paper px-4 py-3 text-base text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
        />

        <label htmlFor="password" className="mb-2 block text-base font-semibold text-ink">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          className="w-full rounded-md border border-line bg-paper px-4 py-3 text-base text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
        />

        {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}

        <button
          type="submit"
          className="mt-5 w-full rounded-md bg-cobalt px-5 py-3 text-base font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
        >
          Continue →
        </button>
      </form>
    );
  }

  if (step === 'workspace') {
    return (
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setSubmitting(true);
          try {
            const res = await fetch('/api/signup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, email, password, workspaceName }),
            });
            if (!res.ok) {
              const body: { error?: string } = await res.json();
              setError(body.error ?? 'Something went wrong creating your account.');
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

            // Free while solo (Issue 10.9 amendment): new workspaces start on
            // STARTER/NONE with no Stripe touch at signup — billing only kicks
            // in when a second member actually joins (see invites/[token]/accept).
            router.push(`/workspaces/${workspaceId}`);
          } catch {
            setError('Something went wrong. Please try again.');
            setSubmitting(false);
          }
        }}
        className="rounded-lg border border-line bg-panel p-8"
      >
        <div className="mb-4 font-mono text-sm text-sub">STEP 2 OF 2 — YOUR WORKSPACE</div>

        <label htmlFor="workspaceName" className="mb-2 block text-base font-semibold text-ink">
          Workspace name
        </label>
        <input
          id="workspaceName"
          type="text"
          required
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
          placeholder="Acme Corp"
          className="w-full rounded-md border border-line bg-paper px-4 py-3 text-base text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
        />

        {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={() => setStep('account')}
            disabled={submitting}
            className="rounded-md border border-line bg-transparent px-5 py-3 text-base font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
          >
            ← Back
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex-1 rounded-md bg-cobalt px-5 py-3 text-base font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
          >
            {submitting ? 'Creating workspace…' : 'Create workspace →'}
          </button>
        </div>
      </form>
    );
  }

  return null;
}
