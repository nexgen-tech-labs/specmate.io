import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireProjectRole } from '@/lib/workspace-context';

type Params = {
  params: Promise<{ workspaceId: string; projectId: string; itemId: string }>;
};

// Auth-gated proxy to apps/api's flag-removed endpoint (Issue 9.4) — the browser
// never talks to apps/api directly (internal-only ingress; see architecture.md).
export async function POST(_request: Request, { params }: Params) {
  const { workspaceId, projectId, itemId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const item = await prisma.draftItem.findFirst({
    where: { id: itemId, projectId, deletedAt: null },
  });
  if (!item) {
    return NextResponse.json({ error: 'Item not found.' }, { status: 404 });
  }

  const session = await auth();
  try {
    const response = await fetch(`${process.env.API_BASE_URL}/draft-items/${itemId}/flag-removed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: workspaceId,
        actor_user_id: session?.user?.id ?? null,
      }),
    });
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Publishing service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
