import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string }> };

async function proxy(
  method: 'GET' | 'POST',
  projectId: string,
  body?: unknown,
): Promise<NextResponse> {
  try {
    const response = await fetch(
      `${process.env.API_BASE_URL}/projects/${projectId}/publish-mapping/jira`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Publishing service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}

export async function GET(_request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  return proxy('GET', projectId);
}

// Mapping configuration is a connector-setup concern — ADMIN only (Issue 5.3).
export async function POST(request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  return proxy('POST', projectId, await request.json());
}
