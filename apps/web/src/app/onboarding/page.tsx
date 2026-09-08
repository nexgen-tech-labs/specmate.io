import type { Metadata } from 'next';
import Link from 'next/link';
import { OnboardingForm } from './onboarding-form';
import { isSignupEnabled } from '@/lib/signup-gate';

export const metadata: Metadata = {
  title: 'Get Started — SpecMate',
  description: 'Start onboarding your team onto SpecMate.',
};

export default function OnboardingPage() {
  if (!isSignupEnabled()) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md text-center">
          <h1 className="text-4xl font-bold tracking-tight text-ink">Invite-only beta</h1>
          <p className="mt-3 text-lg text-sub">
            Sign-ups are currently invite-only. Request access from the homepage and we&apos;ll
            follow up.
          </p>
          <Link
            href="/"
            className="mt-6 inline-block rounded-md bg-cobalt px-5 py-3 text-sm font-semibold text-white"
          >
            ← Back to homepage
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-ink">Get started with SpecMate</h1>
          <p className="mt-3 text-lg text-sub">
            Tell us your work email and we&apos;ll set up your workspace.
          </p>
        </div>
        <OnboardingForm />
      </div>
    </div>
  );
}
