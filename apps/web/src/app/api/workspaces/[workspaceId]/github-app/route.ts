import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string }> };

// Lists unclaimed GitHub App installs (Issue 10.3) — accounts that installed
// the app but haven't been linked to a SpecMate workspace yet. There is no
// way to know which SpecMate workspace a GitHub App install belongs to at
// install time (the GitHub org/user admin installing the app has no
// SpecMate account context), so claiming is a manual step here, matched by
// account login — mirrors api/workspaces/[workspaceId]/atlassian-connect's
// claim endpoint exactly.
export async function GET(_request: Request, { params }: Params) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const [claimed, unclaimed] = await Promise.all([
    prisma.gitHubAppInstall.findMany({
      where: { workspaceId, uninstalledAt: null },
      select: {
        id: true,
        accountLogin: true,
        accountType: true,
        repositorySelection: true,
        installedAt: true,
      },
    }),
    prisma.gitHubAppInstall.findMany({
      where: { workspaceId: null, uninstalledAt: null },
      select: {
        id: true,
        accountLogin: true,
        accountType: true,
        repositorySelection: true,
        installedAt: true,
      },
    }),
  ]);

  return NextResponse.json({ claimed, unclaimed });
}

// Claims an unclaimed install for this workspace (Issue 10.3 AC: "Installation
// correctly provisions workspace access").
export async function POST(request: Request, { params }: Params) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  const body = (await request.json().catch(() => ({}))) as { installId?: unknown };
  if (typeof body.installId !== 'string') {
    return NextResponse.json({ error: 'installId is required.' }, { status: 400 });
  }

  const install = await prisma.gitHubAppInstall.findUnique({
    where: { id: body.installId },
  });
  if (!install || install.uninstalledAt) {
    return NextResponse.json({ error: 'Install not found or uninstalled.' }, { status: 404 });
  }
  if (install.workspaceId && install.workspaceId !== workspaceId) {
    return NextResponse.json(
      { error: 'This install is already claimed by a different workspace.' },
      { status: 409 },
    );
  }

  await prisma.gitHubAppInstall.update({
    where: { id: install.id },
    data: { workspaceId, claimedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
