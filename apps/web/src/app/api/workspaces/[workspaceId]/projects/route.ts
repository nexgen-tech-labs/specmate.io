import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string }> };

// Project creation (Issue 10.10 — onboarding needs a project to land in; no
// project-creation surface existed before this).
export async function POST(request: Request, { params }: Params) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json({ error: 'Project name is required.' }, { status: 400 });
  }

  const project = await prisma.project.create({ data: { workspaceId, name } });
  return NextResponse.json({ id: project.id, name: project.name }, { status: 201 });
}
