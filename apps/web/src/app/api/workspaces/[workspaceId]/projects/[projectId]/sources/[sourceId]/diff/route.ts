import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireProjectRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string; sourceId: string }> };

// Auth-gated proxy to apps/api's diff endpoint (Issue 9.1) — the browser never
// talks to apps/api directly (it has internal-only ingress in Azure; see architecture.md).
export async function GET(_request: Request, { params }: Params) {
  const { workspaceId, projectId, sourceId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const source = await prisma.source.findFirst({
    where: { id: sourceId, projectId, deletedAt: null, project: { workspaceId } },
  });
  if (!source) {
    return NextResponse.json({ error: 'Source not found.' }, { status: 404 });
  }

  try {
    const response = await fetch(`${process.env.API_BASE_URL}/sources/${sourceId}/diff`);
    const body: unknown = await response.json();
    return NextResponse.json(body, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Diff service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
