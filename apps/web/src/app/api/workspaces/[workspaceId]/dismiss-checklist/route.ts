import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string }> };

// Dismisses the dashboard's "Set up your workspace" checklist for everyone
// in the workspace (Onboarding Flow redesign) — server-side, not
// localStorage, so dismissal is consistent across devices/teammates,
// matching the checklist's own completion state (already server-derived).
export async function POST(_request: Request, { params }: Params) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { onboardingChecklistDismissedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
