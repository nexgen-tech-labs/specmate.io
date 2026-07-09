'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';

function LoginFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') ?? '/';

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
        router.push(callbackUrl);
        router.refresh();
      }}
      className="rounded-lg border border-line bg-panel p-8"
    >
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
