import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string }> };

// Team management (Issues 12.10/12.11) — teams are permission-scoping groups
// within a workspace. Management is effective-ADMIN-only (which includes org
// OWNER/ADMINs via role inheritance). The full management UI is Issue #99;
// these endpoints are the server-side contract it will build on.

export async function GET(_request: Request, { params }: Params) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const teams = await prisma.team.findMany({
    where: { workspaceId, deletedAt: null },
    include: {
      members: { select: { userId: true, user: { select: { name: true, email: true } } } },
      projects: { select: { projectId: true } },
    },
    orderBy: { name: 'asc' },
  });

  return NextResponse.json({
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      members: team.members.map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
      })),
      projectIds: team.projects.map((p) => p.projectId),
    })),
  });
}

export async function POST(request: Request, { params }: Params) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'Team name is required.' }, { status: 400 });

  const existing = await prisma.team.findUnique({
    where: { workspaceId_name: { workspaceId, name } },
  });
  if (existing && !existing.deletedAt) {
    return NextResponse.json(
      { error: 'A team with this name already exists in the workspace.' },
      { status: 409 },
    );
  }

  // Resurrecting an archived team of the same name brings it back *empty* —
  // stale members/scopes from its previous life must not silently reapply.
  const team = existing
    ? await prisma.$transaction(async (tx) => {
        await tx.teamMember.deleteMany({ where: { teamId: existing.id } });
        await tx.teamProject.deleteMany({ where: { teamId: existing.id } });
        return tx.team.update({ where: { id: existing.id }, data: { deletedAt: null } });
      })
    : await prisma.team.create({ data: { workspaceId, name } });

  return NextResponse.json({ id: team.id, name: team.name }, { status: 201 });
}
