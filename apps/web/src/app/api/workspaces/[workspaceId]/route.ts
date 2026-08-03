import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string }> };

// Workspace archive (Issue 12.12): straightforward soft-delete, matching the
// existing shallow-archive pattern already used for Team/Organization/Project
// — no cascading changes to child Teams/Projects data.
export async function DELETE(_request: Request, { params }: Params) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  await prisma.workspace.update({ where: { id: workspaceId }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
