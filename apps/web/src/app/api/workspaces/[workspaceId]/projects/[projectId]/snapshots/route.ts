import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string }> };

// Snapshot exports (Issue 8.4) — auth-gated proxy to apps/api.

export async function GET(_request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  try {
    const response = await fetch(`${process.env.API_BASE_URL}/projects/${projectId}/snapshots`);
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Export service is unreachable.' }, { status: 502 });
  }
}

export async function POST(_request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  try {
    const response = await fetch(`${process.env.API_BASE_URL}/projects/${projectId}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor_user_id: access.membership.userId }),
    });
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Export service is unreachable.' }, { status: 502 });
  }
}
