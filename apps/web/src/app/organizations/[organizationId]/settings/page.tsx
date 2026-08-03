import { notFound } from 'next/navigation';
import { requireOrganizationRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';
import { OrgSettings } from './org-settings';

// Organization settings page (Issue 12.12): org name/size, workspace
// create/archive, and member invite/offboard, all in one place — the
// server-side contracts for each already exist (Issue 12.11/12.12).
export default async function OrganizationSettingsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;

  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) notFound();

  const organization = await prisma.organization.findFirst({
    where: { id: organizationId, deletedAt: null },
    select: { name: true, size: true },
  });
  if (!organization) notFound();

  const [workspaces, members] = await Promise.all([
    prisma.workspace.findMany({
      where: { organizationId, deletedAt: null },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.organizationMember.findMany({
      where: { organizationId },
      select: { userId: true, role: true, user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight text-ink">{organization.name}</h1>
      <div className="mt-8">
        <OrgSettings
          organizationId={organizationId}
          initialName={organization.name}
          initialSize={organization.size}
          isOwner={access.membership.role === 'OWNER'}
          currentUserId={access.membership.userId}
          initialWorkspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
          initialMembers={members.map((m) => ({
            userId: m.userId,
            role: m.role,
            name: m.user.name,
            email: m.user.email,
          }))}
        />
      </div>
    </div>
  );
}
