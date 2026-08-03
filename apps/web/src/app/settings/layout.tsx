import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const userId = session?.user?.id;

  const orgMemberships = userId
    ? await prisma.organizationMember.findMany({
        where: { userId },
        select: { organizationId: true, organization: { select: { name: true } } },
      })
    : [];

  return (
    <div className="min-h-screen bg-paper">
      <nav className="border-b border-line bg-panel px-6 py-4">
        <div className="mx-auto flex max-w-3xl items-center gap-6 text-sm font-semibold text-sub">
          {orgMemberships.map((m) => (
            <Link
              key={m.organizationId}
              href={`/organizations/${m.organizationId}/settings`}
              className="hover:text-ink"
            >
              {m.organization.name}
            </Link>
          ))}
          <Link href="/settings/account" className="hover:text-ink">
            Account
          </Link>
        </div>
      </nav>
      {children}
    </div>
  );
}
