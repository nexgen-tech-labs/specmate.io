import { NextResponse } from 'next/server';
import { requireProjectRole } from '@/lib/workspace-context';

type Params = {
  params: Promise<{ workspaceId: string; projectId: string; runId: string }>;
};

// Auth-gated proxy to apps/api's PATCH /generation-runs/{id} — lets a reviewer
// rename a run's AI-suggested tag/name. Exact mirror of the sibling
// generate-downstream/route.ts's shape; projectId is only needed here for the
// requireProjectRole check (apps/api's own route is scoped by runId alone).
export async function PATCH(request: Request, { params }: Params) {
  const { workspaceId, projectId, runId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body: unknown = await request.json().catch(() => ({}));
  try {
    const response = await fetch(`${process.env.API_BASE_URL}/generation-runs/${runId}`, {
      method: 'PATCH',
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
