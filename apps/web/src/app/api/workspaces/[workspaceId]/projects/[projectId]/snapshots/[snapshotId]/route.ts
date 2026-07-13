import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = {
  params: Promise<{ workspaceId: string; projectId: string; snapshotId: string }>;
};

// One snapshot's stored JSON, or its PDF rendering via ?format=pdf (Issue 8.4).
export async function GET(request: Request, { params }: Params) {
  const { workspaceId, projectId, snapshotId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const wantsPdf = new URL(request.url).searchParams.get('format') === 'pdf';
  const upstream = `${process.env.API_BASE_URL}/projects/${projectId}/snapshots/${snapshotId}${wantsPdf ? '/pdf' : ''}`;
  try {
    const response = await fetch(upstream);
    if (wantsPdf && response.ok) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition':
            response.headers.get('Content-Disposition') ?? 'attachment; filename="snapshot.pdf"',
        },
      });
    }
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Export service is unreachable.' }, { status: 502 });
  }
}
