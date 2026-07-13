import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string }> };

// Auth-gated proxy to apps/api's ado publish endpoint (internal-only ingress).
export async function POST(request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;
  try {
    const response = await fetch(`${process.env.API_BASE_URL}/projects/${projectId}/publish/ado`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // actor_user_id comes from the authenticated session, never the client body —
      // publish audit events (Issue 8.1) must carry the real actor.
      body: JSON.stringify({ ...body, actor_user_id: access.membership.userId }),
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
