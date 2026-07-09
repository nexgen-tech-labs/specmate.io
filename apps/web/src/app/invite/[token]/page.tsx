import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { AcceptInviteButton } from './accept-invite-button';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const invite = await prisma.workspaceInvite.findUnique({
    where: { token },
    include: { workspace: true },
  });

  if (!invite || invite.status !== 'PENDING' || invite.expiresAt < new Date()) {
    notFound();
  }

  const session = await auth();
  const signedInEmail = session?.user?.email;
  const emailMatches = signedInEmail === invite.email;

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6">
      <div className="w-full max-w-md rounded-lg border border-line bg-panel p-8 text-center">
        <div className="font-mono text-sm text-sub">WORKSPACE INVITE</div>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-ink">{invite.workspace.name}</h1>
        <p className="mt-3 text-base text-sub">
          You&apos;ve been invited to join as{' '}
          <span className="font-semibold text-ink">{invite.role}</span>.
        </p>

        {!signedInEmail ? (
          <p className="mt-5 text-sm text-sub">
            Sign in or create an account with{' '}
            <span className="font-semibold text-ink">{invite.email}</span> to accept this invite.
          </p>
        ) : !emailMatches ? (
          <p className="mt-5 text-sm text-red">
            This invite was sent to {invite.email}, but you&apos;re signed in as {signedInEmail}.
          </p>
        ) : (
          <AcceptInviteButton token={token} />
        )}
      </div>
    </div>
  );
}
