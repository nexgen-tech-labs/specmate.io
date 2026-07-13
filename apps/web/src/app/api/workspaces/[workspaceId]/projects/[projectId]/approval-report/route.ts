import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string }> };

// Approval report (Issue 8.5): JSON by default, PDF via ?format=pdf; optional
// ?from=YYYY-MM-DD&to=YYYY-MM-DD date-range scoping.
export async function GET(request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;
  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const url = new URL(request.url);
  const wantsPdf = url.searchParams.get('format') === 'pdf';
  const query = new URLSearchParams();
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from) query.set('date_from', from);
  if (to) query.set('date_to', to);
  const qs = query.toString() ? `?${query.toString()}` : '';

  const upstream = `${process.env.API_BASE_URL}/projects/${projectId}/approval-report${wantsPdf ? '/pdf' : ''}${qs}`;
  try {
    const response = await fetch(upstream);
    if (wantsPdf && response.ok) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition':
            response.headers.get('Content-Disposition') ??
            'attachment; filename="approval-report.pdf"',
        },
      });
    }
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Report service is unreachable.' }, { status: 502 });
  }
}
