import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string; sourceId: string }> };

async function findSource(workspaceId: string, projectId: string, sourceId: string) {
  return prisma.source.findFirst({
    where: { id: sourceId, projectId, deletedAt: null, project: { workspaceId } },
  });
}

// Soft-delete: the Source and its RawRequirements get deletedAt stamped (removed from
// active use), rows are never hard-deleted, and an AuditEvent records the action — so
// historical trace/audit records keep resolving.
export async function DELETE(_request: Request, { params }: Params) {
  const { workspaceId, projectId, sourceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const source = await findSource(workspaceId, projectId, sourceId);
  if (!source) {
    return NextResponse.json({ error: 'Source not found.' }, { status: 404 });
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.rawRequirement.updateMany({
      where: { sourceId, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.source.update({ where: { id: sourceId }, data: { deletedAt: now } }),
    prisma.auditEvent.create({
      data: {
        workspaceId,
        actorUserId: access.membership.userId,
        action: 'source.deleted',
        entityType: 'Source',
        entityId: sourceId,
        metadata: { name: source.name, kind: source.kind },
      },
    }),
  ]);

  return NextResponse.json({ deleted: true });
}
