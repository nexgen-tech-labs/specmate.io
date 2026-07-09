import type { Metadata } from 'next';
import { OnboardingForm } from './onboarding-form';

export const metadata: Metadata = {
  title: 'Get Started — SpecMate',
  description: 'Start onboarding your team onto SpecMate.',
};

export default function OnboardingPage() {
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
