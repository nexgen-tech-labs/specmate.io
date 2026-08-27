'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { ORG_SIZE_OPTIONS } from '@/lib/org-size';
import type { OrgSize } from '@prisma/client';

type Step = 'account' | 'organization' | 'workspace' | 'provisioning';

const STEPS: Array<{ key: Exclude<Step, 'provisioning'>; label: string }> = [
  { key: 'account', label: 'Account' },
  { key: 'organization', label: 'Organization' },
  { key: 'workspace', label: 'Workspace' },
];

function StepIndicator({ step }: { step: Exclude<Step, 'provisioning'> }) {
  const activeIndex = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="mb-9 flex items-center justify-center gap-0">
      {STEPS.map((s, i) => {
        const done = activeIndex > i;
        const active = activeIndex === i;
        return (
          <li key={s.key} className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <span
                className={`flex size-6 items-center justify-center rounded-full font-mono text-xs font-bold ${
                  done
                    ? 'bg-green text-white'
                    : active
                      ? 'bg-cobalt text-white'
                      : 'bg-line text-sub'
                }`}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={`text-xs whitespace-nowrap ${active ? 'font-bold text-ink' : 'text-sub'}`}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 ? <span className="mx-2.5 text-line">—</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function OnboardingForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('account');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [orgName, setOrgName] = useState('');
  const [orgNameTouched, setOrgNameTouched] = useState(false);
  const [orgSize, setOrgSize] = useState<OrgSize>('SOLO');

  const [workspaceName, setWorkspaceName] = useState('');

  const [error, setError] = useState<string | null>(null);

  async function finishSignup() {
    setError(null);
    setStep('provisioning');
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          password,
          orgName,
          orgSize,
          workspaceName,
        }),
      });
      if (!res.ok) {
        const body: { error?: string } = await res.json();
        setError(body.error ?? 'Something went wrong creating your account.');
        setStep('workspace');
        return;
      }
      const { workspaceId }: { workspaceId: string } = await res.json();

      const result = await signIn('credentials', { email, password, redirect: false });
      if (result?.error) {
        setError('Account created, but sign-in failed. Try logging in manually.');
        setStep('workspace');
        return;
      }

      // Free while solo (Issue 10.9 amendment): new workspaces start on
      // STARTER/NONE with no Stripe touch at signup — billing only kicks
      // in when a second member actually joins (see invites/[token]/accept).
      router.push(`/workspaces/${workspaceId}`);
    } catch {
      setError('Something went wrong. Please try again.');
      setStep('workspace');
    }
  }

  if (step === 'account') {
    return (
      <>
        <StepIndicator step={step} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (password.length < 8) {
              setError('Password must be at least 8 characters.');
              return;
            }
            if (!orgNameTouched) setOrgName(name ? `${name.split(' ')[0]}'s Company` : '');
            setStep('organization');
          }}
          className="rounded-xl border border-line bg-panel p-9"
        >
          <div className="mb-1.5 font-mono text-xs text-sub">STEP 1 OF 3 — YOUR ACCOUNT</div>
          <h2 className="mb-5.5 text-xl font-bold tracking-tight text-ink">Create your account</h2>

          <label htmlFor="name" className="mb-1.5 block text-sm font-semibold text-ink">
            Full name
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            className="mb-4 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
          />

          <label htmlFor="email" className="mb-1.5 block text-sm font-semibold text-ink">
            Work email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="mb-4 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
          />

          <label htmlFor="password" className="mb-1.5 block text-sm font-semibold text-ink">
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
            className="w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
          />

          {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}

          <button
            type="submit"
            className="mt-5.5 w-full rounded-md bg-cobalt px-5 py-3.5 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
          >
            Continue →
          </button>
        </form>
      </>
    );
  }

  if (step === 'organization') {
    return (
      <>
        <StepIndicator step={step} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (!workspaceName)
              setWorkspaceName(orgSize === 'SOLO' ? 'My Workspace' : 'Engineering');
            setStep('workspace');
          }}
          className="rounded-xl border border-line bg-panel p-9"
        >
          <div className="mb-1.5 font-mono text-xs text-sub">STEP 2 OF 3 — YOUR ORGANIZATION</div>
          <h2 className="mb-2 text-xl font-bold tracking-tight text-ink">Name your organization</h2>
          <p className="mb-5.5 text-sm leading-relaxed text-sub">
            Your organization is the top-level account that owns billing and every workspace inside
            it. You&apos;re the owner.
          </p>

          <label htmlFor="orgName" className="mb-1.5 block text-sm font-semibold text-ink">
            Organization name
          </label>
          <input
            id="orgName"
            type="text"
            required
            value={orgName}
            onChange={(e) => {
              setOrgName(e.target.value);
              setOrgNameTouched(true);
            }}
            placeholder="Acme Corp"
            className="mb-4 w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
          />

          <label htmlFor="orgSize" className="mb-1.5 block text-sm font-semibold text-ink">
            Company size
          </label>
          <select
            id="orgSize"
            value={orgSize}
            onChange={(e) => setOrgSize(e.target.value as OrgSize)}
            className="w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
          >
            {ORG_SIZE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}

          <div className="mt-5.5 flex gap-2.5">
            <button
              type="button"
              onClick={() => setStep('account')}
              className="rounded-md border border-line bg-transparent px-4.5 py-3.5 text-sm font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
            >
              ← Back
            </button>
            <button
              type="submit"
              className="flex-1 rounded-md bg-cobalt px-5 py-3.5 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
            >
              Continue →
            </button>
          </div>
        </form>
      </>
    );
  }

  if (step === 'workspace') {
    return (
      <>
        <StepIndicator step={step} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void finishSignup();
          }}
          className="rounded-xl border border-line bg-panel p-9"
        >
          <div className="mb-1.5 font-mono text-xs text-sub">STEP 3 OF 3 — YOUR WORKSPACE</div>
          <h2 className="mb-2 text-xl font-bold tracking-tight text-ink">
            Create your first workspace
          </h2>
          <p className="mb-5.5 text-sm leading-relaxed text-sub">
            Workspaces split <strong>{orgName}</strong> into teams or products, each with its own
            projects and members. You can add more later.
          </p>

          <label htmlFor="workspaceName" className="mb-1.5 block text-sm font-semibold text-ink">
            Workspace name
          </label>
          <input
            id="workspaceName"
            type="text"
            required
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="Engineering"
            className="w-full rounded-md border border-line bg-paper px-3.5 py-3 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
          />

          {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}

          <div className="mt-5.5 flex gap-2.5">
            <button
              type="button"
              onClick={() => setStep('organization')}
              className="rounded-md border border-line bg-transparent px-4.5 py-3.5 text-sm font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
            >
              ← Back
            </button>
            <button
              type="submit"
              className="flex-1 rounded-md bg-cobalt px-5 py-3.5 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
            >
              Enter workspace →
            </button>
          </div>
          <p className="mt-4.5 font-mono text-xs leading-relaxed text-sub">
            Connecting tools and inviting teammates wait for you on the dashboard. Nothing else
            blocks you.
          </p>
        </form>
      </>
    );
  }

  if (step === 'provisioning') {
    return (
      <div className="flex flex-col items-center gap-4.5 py-16">
        <div className="size-8 animate-spin rounded-full border-[3px] border-line border-t-cobalt" />
        <p className="font-mono text-sm text-sub">
          Creating {orgName || 'your organization'} / {workspaceName || 'your workspace'}…
        </p>
      </div>
    );
  }

  return null;
}
