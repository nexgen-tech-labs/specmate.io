import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string }> };

// Auth-gated proxy to apps/api's generation endpoint (internal-only ingress).
// No web UI triggered a generation run before this (Issue 10.10's onboarding
// wizard is the first caller); mirrors the publish proxies' shape.
export async function POST(request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const body: unknown = await request.json().catch(() => ({}));
  try {
    const response = await fetch(`${process.env.API_BASE_URL}/projects/${projectId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Generation service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
