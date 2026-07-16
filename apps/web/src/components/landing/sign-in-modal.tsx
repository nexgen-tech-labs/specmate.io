'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Mono } from './demo-ui';

type AuthMode = 'signin' | 'signup';

const OAUTH_PROVIDERS = [
  { key: 'google', label: 'Continue with Google', glyph: 'G' },
  { key: 'microsoft', label: 'Continue with Microsoft', glyph: 'M' },
  { key: 'github', label: 'Continue with GitHub', glyph: '◐' },
  { key: 'jira', label: 'Continue with Jira', glyph: '◆' },
];

interface SignInModalProps {
  authMode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
  onBackHome: () => void;
}

export function SignInModal({ authMode, onModeChange, onClose, onBackHome }: SignInModalProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 grid place-items-center bg-ink/45 p-5">
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm rounded-lg border border-line bg-panel p-7"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3.5 right-3.5 border-none bg-transparent text-base leading-none text-sub"
        >
          ✕
        </button>

        <button
          onClick={onBackHome}
          className="mb-4.5 rounded-md border border-line bg-transparent px-2.5 py-1.5 font-mono text-xs text-sub focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
        >
          ← Back to Home
        </button>

        <div className="mb-1 flex items-center gap-2">
          <div className="grid size-5 place-items-center rounded bg-cobalt font-mono text-xs font-bold text-white">
            S
          </div>
          <span className="font-bold tracking-tight">SpecMate</span>
        </div>
        <h2 className="mt-3.5 mb-0.5 text-lg font-bold tracking-tight">
          {authMode === 'signin' ? 'Sign in to your workspace' : 'Create your workspace'}
        </h2>
        <p className="m-0 mb-4.5 text-sm text-sub">
          {authMode === 'signin' ? 'Welcome back.' : 'Free to start, no card required.'}
        </p>

        <div className="grid gap-2">
          {OAUTH_PROVIDERS.map((p) => (
            <button
              key={p.key}
              type="button"
              disabled
              title="Coming soon"
              className="flex items-center gap-2.5 rounded-md border border-line bg-panel px-3 py-2.5 text-left font-mono text-xs text-ink opacity-50"
            >
              <span className="w-4.5 text-center text-cobalt">{p.glyph}</span>
              {p.label}
              <Mono className="ml-auto text-sub">soon</Mono>
            </button>
          ))}
        </div>

        <div className="my-4.5 flex items-center gap-2.5">
          <div className="h-px flex-1 bg-line" />
          <Mono className="text-sub">OR</Mono>
          <div className="h-px flex-1 bg-line" />
        </div>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (authMode === 'signup') {
              onClose();
              router.push('/onboarding');
              return;
            }
            setError(null);
            setSubmitting(true);
            const result = await signIn('credentials', { email, password, redirect: false });
            if (result?.error) {
              setError('Invalid email or password.');
              setSubmitting(false);
              return;
            }
            onClose();
            router.push('/');
            router.refresh();
          }}
          className="grid gap-2"
        >
          <input
            type="email"
            placeholder="Work email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
          />
          {error ? <p className="text-sm text-red">{error}</p> : null}
          <button
            type="submit"
            disabled={submitting}
            className="mt-1 rounded-md bg-cobalt px-3 py-2.5 font-mono text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
          >
            {submitting ? 'Signing in…' : authMode === 'signin' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-sub">
          {authMode === 'signin' ? (
            <>
              No account?{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onModeChange('signup');
                }}
                className="font-semibold text-cobalt no-underline"
              >
                Get started
              </a>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onModeChange('signin');
                }}
                className="font-semibold text-cobalt no-underline"
              >
                Sign in
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
