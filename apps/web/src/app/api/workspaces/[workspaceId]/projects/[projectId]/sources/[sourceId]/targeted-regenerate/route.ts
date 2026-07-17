import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireProjectRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string; sourceId: string }> };

// Auth-gated proxy to apps/api's targeted-regenerate endpoint (Issue 9.2) — the
// browser never talks to apps/api directly (internal-only ingress; see architecture.md).
export async function POST(_request: Request, { params }: Params) {
  const { workspaceId, projectId, sourceId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER']);
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
    const response = await fetch(
      `${process.env.API_BASE_URL}/sources/${sourceId}/targeted-regenerate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      },
    );
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Generation service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
