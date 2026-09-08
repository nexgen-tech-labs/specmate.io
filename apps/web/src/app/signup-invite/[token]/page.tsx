import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { SignupInviteForm } from './signup-invite-form';

export default async function SignupInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const signupToken = await prisma.signupToken.findUnique({
    where: { token },
    include: { accessRequest: true },
  });

  if (!signupToken || signupToken.usedAt || signupToken.expiresAt < new Date()) {
    notFound();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-ink">You&apos;re in</h1>
          <p className="mt-3 text-lg text-sub">
            Finish setting up your account for{' '}
            <span className="font-semibold text-ink">{signupToken.accessRequest.companyName}</span>.
          </p>
        </div>
        <SignupInviteForm
          token={token}
          email={signupToken.email}
          companyName={signupToken.accessRequest.companyName}
        />
      </div>
    </div>
  );
}
