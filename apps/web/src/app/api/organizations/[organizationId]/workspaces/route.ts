import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrganizationRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ organizationId: string }> };

// Org-level workspace lifecycle (Issue 12.11: Org OWNER/ADMIN can create
// Workspaces). Until now workspaces were only ever created at signup — this is
// what makes multi-workspace organizations actually reachable. The full org
// management UI is Issue #99; this is the server-side contract for it.

export async function GET(_request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const workspaces = await prisma.workspace.findMany({
    where: { organizationId, deletedAt: null },
    select: { id: true, name: true, createdAt: true, pricingTier: true },
    orderBy: { createdAt: 'asc' },
  });
  return NextResponse.json({ workspaces });
}

export async function POST(request: Request, { params }: Params) {
  const { organizationId } = await params;
  const access = await requireOrganizationRole(organizationId, ['OWNER', 'ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const organization = await prisma.organization.findFirst({
    where: { id: organizationId, deletedAt: null },
  });
  if (!organization) {
    return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'Workspace name is required.' }, { status: 400 });

  // The creator gets an explicit WorkspaceMember ADMIN row in addition to their
  // implicit org-derived access — so their membership survives even if their
  // org role is later downgraded.
  const workspace = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({ data: { name, organizationId } });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: access.membership.userId, role: 'ADMIN' },
    });
    return workspace;
  });

  return NextResponse.json({ id: workspace.id, name: workspace.name }, { status: 201 });
}
