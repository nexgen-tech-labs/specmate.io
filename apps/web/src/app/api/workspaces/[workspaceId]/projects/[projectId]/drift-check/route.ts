import { NextResponse } from 'next/server';
import { requireProjectRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string }> };

// Auth-gated proxy to apps/api's drift-check endpoint (Issue 9.5) — the browser
// never talks to apps/api directly (internal-only ingress; see architecture.md).
export async function POST(_request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  try {
    const response = await fetch(`${process.env.API_BASE_URL}/projects/${projectId}/drift-check`, {
      method: 'POST',
    });
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Drift check service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
