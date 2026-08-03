import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string; userId: string }> };

// Offboarding (Issue 12.12 AC 3): removes a departing user's access
// org-wide in one transaction — OrganizationMember + every WorkspaceMember
// row in every Workspace of this org + every TeamMember row in every Team of
// every Workspace of this org. Missing any one of these would leave
// orphaned access (a direct WorkspaceMember row grants access independent
// of org membership — see workspace-access.ts). OWNER-only: removing a
// person's entire access is a higher-privilege action than day-to-day
// workspace/team management (ADMIN-permitted elsewhere).
export async function DELETE(_request: Request, { params }: Params) {
  const { organizationId, userId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const targetMembership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!targetMembership) {
    return NextResponse.json(
      { error: 'This user is not a member of the organization.' },
      { status: 404 },
    );
  }

  const workspaces = await prisma.workspace.findMany({
    where: { organizationId },
    select: { id: true },
  });
  const workspaceIds = workspaces.map((w) => w.id);

  // Only workspaces where the departing user held a direct WorkspaceMember row
  // get an audit event — org-role-inherited access was never itself a
  // persisted grant, so there's nothing workspace-specific to log for those.
  const affectedMemberships =
    workspaceIds.length > 0
      ? await prisma.workspaceMember.findMany({
          where: { userId, workspaceId: { in: workspaceIds } },
          select: { workspaceId: true },
        })
      : [];
  const affectedWorkspaceIds = affectedMemberships.map((m) => m.workspaceId);

  await prisma.$transaction(async (tx) => {
    if (workspaceIds.length > 0) {
      const teamIds = (
        await tx.team.findMany({
          where: { workspaceId: { in: workspaceIds } },
          select: { id: true },
        })
      ).map((t) => t.id);
      if (teamIds.length > 0) {
        await tx.teamMember.deleteMany({ where: { userId, teamId: { in: teamIds } } });
      }
      await tx.workspaceMember.deleteMany({ where: { userId, workspaceId: { in: workspaceIds } } });
    }
    await tx.organizationMember.deleteMany({ where: { organizationId, userId } });

    for (const workspaceId of affectedWorkspaceIds) {
      await tx.auditEvent.create({
        data: {
          workspaceId,
          actorUserId: access.membership.userId,
          actorType: 'USER',
          action: 'user.offboarded',
          entityType: 'User',
          entityId: userId,
          metadata: { organizationId },
        },
      });
    }
  });

  return NextResponse.json({ ok: true });
}
