import { NextResponse } from 'next/server';
import { requireProjectRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string; toolKey: string }> };

// Connector setup is an ADMIN concern (Issue 5.3) — the wizard's discovery
// probe is gated the same as every other connector-setup route (Issue #101).
export async function POST(request: Request, { params }: Params) {
  const { workspaceId, projectId, toolKey } = await params;
  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body: unknown = await request.json().catch(() => ({}));

  try {
    const response = await fetch(
      `${process.env.API_BASE_URL}/workspaces/${workspaceId}/projects/${projectId}/connectors/${toolKey}/test`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Connector service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
