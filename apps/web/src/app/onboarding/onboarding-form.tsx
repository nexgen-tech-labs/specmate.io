'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';

type Step = 'account' | 'workspace' | 'plan';
type Tier = 'STARTER' | 'ENTERPRISE';

export function OnboardingForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('account');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
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
            const { workspaceId: newWorkspaceId }: { workspaceId: string } = await res.json();

            const result = await signIn('credentials', { email, password, redirect: false });
            if (result?.error) {
              setError('Account created, but sign-in failed. Try logging in manually.');
              setSubmitting(false);
              return;
            }

            setWorkspaceId(newWorkspaceId);
            setSubmitting(false);
            setStep('plan');
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

  // step === 'plan' — Issue 10.9: pick a self-serve (Starter, Stripe Checkout)
  // or sales-assisted (Enterprise) tier before landing in the dashboard.
  return (
    <PlanSelection
      submitting={submitting}
      error={error}
      onSelect={async (tier: Tier) => {
        setError(null);
        setSubmitting(true);
        if (tier === 'ENTERPRISE') {
          await fetch(`/api/workspaces/${workspaceId}/billing/tier`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tier: 'ENTERPRISE' }),
          });
          router.push(`/workspaces/${workspaceId}`);
          return;
        }
        const res = await fetch(`/api/workspaces/${workspaceId}/billing/checkout`, {
          method: 'POST',
        });
        if (!res.ok) {
          const body: { error?: string } = await res.json().catch(() => ({}));
          setError(body.error ?? 'Could not start checkout.');
          setSubmitting(false);
          return;
        }
        const { url }: { url: string } = await res.json();
        window.location.href = url;
      }}
      onSkip={() => router.push(`/workspaces/${workspaceId}`)}
    />
  );
}

function PlanSelection({
  submitting,
  error,
  onSelect,
  onSkip,
}: {
  submitting: boolean;
  error: string | null;
  onSelect: (tier: Tier) => void;
  onSkip: () => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-panel p-8">
      <div className="mb-4 font-mono text-sm text-sub">CHOOSE A PLAN</div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <button
          type="button"
          disabled={submitting}
          onClick={() => onSelect('STARTER')}
          className="rounded-lg border border-line bg-paper p-5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt disabled:opacity-50"
        >
          <div className="text-lg font-bold text-ink">Starter</div>
          <p className="mt-1 text-sm text-sub">
            Self-serve. Base subscription + usage-based pricing per published item.
          </p>
          <div className="mt-3 text-sm font-semibold text-cobalt">Start free trial →</div>
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => onSelect('ENTERPRISE')}
          className="rounded-lg border border-line bg-paper p-5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt disabled:opacity-50"
        >
          <div className="text-lg font-bold text-ink">Enterprise</div>
          <p className="mt-1 text-sm text-sub">
            Custom pricing, sales-assisted onboarding, for larger orgs and pilots.
          </p>
          <div className="mt-3 text-sm font-semibold text-cobalt">Contact sales →</div>
        </button>
      </div>

      {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}

      <button
        type="button"
        disabled={submitting}
        onClick={onSkip}
        className="mt-5 text-sm text-sub underline-offset-2 hover:underline"
      >
        Skip for now, decide later
      </button>
    </div>
  );
}
