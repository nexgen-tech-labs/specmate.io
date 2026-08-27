import { NextResponse } from 'next/server';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { prisma } from '@/lib/prisma';

type Params = { params: Promise<{ workspaceId: string }> };

interface ConnectorScopeBody {
  connectionId?: unknown;
  scopeValue?: unknown;
  scopeLabel?: unknown;
}

// Records which board/project/repo a workspace picked from its organization's
// tool authorization (design: "Authorize once, use everywhere — each
// workspace picks which board or repo it works against"). Lives in apps/web,
// not apps/api, since workspace-membership authorization is apps/web's job —
// matching the existing pattern for workspace-scoped writes.
export async function POST(request: Request, { params }: Params) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body = (await request.json().catch(() => ({}))) as ConnectorScopeBody;
  const { connectionId, scopeValue, scopeLabel } = body;
  if (
    typeof connectionId !== 'string' ||
    typeof scopeValue !== 'string' ||
    typeof scopeLabel !== 'string'
  ) {
    return NextResponse.json(
      { error: 'connectionId, scopeValue, and scopeLabel are required strings.' },
      { status: 400 },
    );
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  if (!workspace?.organizationId) {
    return NextResponse.json(
      {
        error:
          'This workspace has no organization — connector scopes require org-level authorization.',
      },
      { status: 400 },
    );
  }

  // The connection must actually belong to this workspace's own organization
  // — otherwise a workspace admin could pin a scope to another org's
  // authorized connection.
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { organizationId: true },
  });
  if (!connection || connection.organizationId !== workspace.organizationId) {
    return NextResponse.json(
      { error: 'Connection not found for this organization.' },
      { status: 404 },
    );
  }

  const scope = await prisma.workspaceConnectionScope.upsert({
    where: { workspaceId_connectionId: { workspaceId, connectionId } },
    create: { workspaceId, connectionId, scopeValue, scopeLabel },
    update: { scopeValue, scopeLabel },
  });

  return NextResponse.json({
    id: scope.id,
    workspaceId: scope.workspaceId,
    connectionId: scope.connectionId,
    scopeValue: scope.scopeValue,
    scopeLabel: scope.scopeLabel,
  });
}
