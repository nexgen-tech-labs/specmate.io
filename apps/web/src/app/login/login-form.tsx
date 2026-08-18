'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

function LoginFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const explicitCallbackUrl = searchParams.get('callbackUrl');
  const callbackUrl = explicitCallbackUrl ?? '/';
  const oauthError = searchParams.get('error');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSubmitting(true);
        const result = await signIn('credentials', { email, password, redirect: false });
        if (result?.error) {
          setError('Invalid email or password.');
          setSubmitting(false);
          return;
        }
        if (explicitCallbackUrl) {
          router.push(explicitCallbackUrl);
        } else {
          // No explicit destination (user landed on /login directly, not via
          // proxy.ts's redirect from a protected route) — resolve their
          // workspace the same way the landing page's sign-in modal does.
          const res = await fetch('/api/me/workspace');
          const { workspaceId }: { workspaceId: string | null } = res.ok
            ? await res.json()
            : { workspaceId: null };
          router.push(workspaceId ? `/workspaces/${workspaceId}` : '/onboarding');
        }
        router.refresh();
      }}
      className="rounded-lg border border-line bg-panel p-8"
    >
      {oauthError === 'AccountExists' ? (
        <p className="mb-4 text-sm text-red">
          An account with this email already exists. Sign in with your password, then link this
          provider from account settings.
        </p>
      ) : null}

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
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-md border border-line bg-paper px-4 py-3 text-base text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
      />

      {error ? <p className="mt-3 text-sm text-red">{error}</p> : null}

      <button
        type="submit"
        disabled={submitting}
        className="mt-5 w-full rounded-md bg-cobalt px-5 py-3 text-base font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
      >
        {submitting ? 'Signing in…' : 'Sign in →'}
      </button>

      <div className="mt-6 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => signIn('github', { callbackUrl })}
          className="w-full rounded-md border border-line bg-paper px-5 py-3 text-base font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
        >
          Continue with GitHub
        </button>
        <button
          type="button"
          onClick={() => signIn('google', { callbackUrl })}
          className="w-full rounded-md border border-line bg-paper px-5 py-3 text-base font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
        >
          Continue with Google
        </button>
        <button
          type="button"
          onClick={() => signIn('microsoft-entra-id', { callbackUrl })}
          className="w-full rounded-md border border-line bg-paper px-5 py-3 text-base font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
        >
          Continue with Microsoft
        </button>
      </div>
    </form>
  );
}

export function LoginForm() {
  return (
    <Suspense fallback={null}>
      <LoginFormInner />
    </Suspense>
  );
}
