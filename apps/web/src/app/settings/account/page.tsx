import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ConnectedAccounts } from './connected-accounts';

export default async function AccountSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

  const [accounts, user] = await Promise.all([
    prisma.account.findMany({
      where: { userId: session.user.id },
      select: { id: true, provider: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { passwordHash: true },
    }),
  ]);

  return (
    <div className="flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-ink">Account settings</h1>
          <p className="mt-2 text-base text-sub">Manage how you sign in</p>
        </div>
        <ConnectedAccounts
          initialAccounts={accounts.map((a) => ({ id: a.id, provider: a.provider }))}
          hasPassword={user.passwordHash !== null}
        />
      </div>
    </div>
  );
}
