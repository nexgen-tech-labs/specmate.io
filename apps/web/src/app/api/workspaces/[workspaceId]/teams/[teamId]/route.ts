import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; teamId: string }> };

async function findTeam(workspaceId: string, teamId: string) {
  return prisma.team.findFirst({ where: { id: teamId, workspaceId, deletedAt: null } });
}

// PATCH: manage a team's members and project scope (Issues 12.10/12.11).
// Accepts any combination of:
//   { addMemberIds: string[], removeMemberIds: string[], projectIds: string[] }
// `projectIds` replaces the team's whole project scope (empty array = unscoped
// team, i.e. a plain grouping that no longer restricts anyone).
export async function PATCH(request: Request, { params }: Params) {
  const { workspaceId, teamId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const team = await findTeam(workspaceId, teamId);
  if (!team) return NextResponse.json({ error: 'Team not found.' }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    addMemberIds?: unknown;
    removeMemberIds?: unknown;
    projectIds?: unknown;
  };
  const addMemberIds = Array.isArray(body.addMemberIds)
    ? body.addMemberIds.filter((id): id is string => typeof id === 'string')
    : [];
  const removeMemberIds = Array.isArray(body.removeMemberIds)
    ? body.removeMemberIds.filter((id): id is string => typeof id === 'string')
    : [];
  const projectIds = Array.isArray(body.projectIds)
    ? body.projectIds.filter((id): id is string => typeof id === 'string')
    : null;

  // Team members must already be workspace members — a team never grants
  // workspace access to outsiders (restriction-not-grant semantics).
  if (addMemberIds.length > 0) {
    const memberCount = await prisma.workspaceMember.count({
      where: { workspaceId, userId: { in: addMemberIds } },
    });
    if (memberCount !== addMemberIds.length) {
      return NextResponse.json(
        { error: 'All team members must already be members of this workspace.' },
        { status: 400 },
      );
    }
  }

  // Scoped projects must belong to this workspace — cross-workspace scoping is
  // meaningless and would silently hide everything from the team.
  if (projectIds && projectIds.length > 0) {
    const projectCount = await prisma.project.count({
      where: { workspaceId, id: { in: projectIds } },
    });
    if (projectCount !== projectIds.length) {
      return NextResponse.json(
        { error: 'All scoped projects must belong to this workspace.' },
        { status: 400 },
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const userId of addMemberIds) {
      await tx.teamMember.upsert({
        where: { teamId_userId: { teamId, userId } },
        create: { teamId, userId },
        update: {},
      });
    }
    if (removeMemberIds.length > 0) {
      await tx.teamMember.deleteMany({ where: { teamId, userId: { in: removeMemberIds } } });
    }
    if (projectIds !== null) {
      await tx.teamProject.deleteMany({ where: { teamId } });
      if (projectIds.length > 0) {
        await tx.teamProject.createMany({
          data: projectIds.map((projectId) => ({ teamId, projectId })),
        });
      }
    }
  });

  return NextResponse.json({ ok: true });
}

// DELETE: soft-delete (archive) the team. Members lose the team's project
// scope, which *widens* their visibility back to the whole workspace — that's
// the restriction-not-grant model working as intended.
export async function DELETE(_request: Request, { params }: Params) {
  const { workspaceId, teamId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const team = await findTeam(workspaceId, teamId);
  if (!team) return NextResponse.json({ error: 'Team not found.' }, { status: 404 });

  await prisma.team.update({ where: { id: teamId }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
