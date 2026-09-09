'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SignInModal } from '@/components/landing/sign-in-modal';

type AuthMode = 'signin' | 'signup';

// Signed-out header controls (Issue 10.11) — split out of AppHeader (a server
// component, for the `auth()` session check) since opening the Sign In modal
// needs client state. "Get Started" deep-links into the homepage's real
// request-access flow rather than /onboarding, which just shows an
// invite-only notice while self-serve signup is disabled.
export function HeaderAuthActions() {
  const router = useRouter();
  const [authModal, setAuthModal] = useState<AuthMode | null>(null);

  return (
    <div className="flex gap-3">
      <button
        type="button"
        onClick={() => setAuthModal('signin')}
        className="rounded-md border border-line bg-transparent px-4 py-2.5 font-mono text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
      >
        Sign In
      </button>
      <Link
        href="/?request-access=1"
        className="rounded-md bg-cobalt px-5 py-2.5 font-mono text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
      >
        Get Started
      </Link>
      {authModal ? (
        <SignInModal
          authMode={authModal}
          onModeChange={setAuthModal}
          onClose={() => setAuthModal(null)}
          onBackHome={() => {
            setAuthModal(null);
            router.push('/');
          }}
        />
      ) : null}
    </div>
  );
}
