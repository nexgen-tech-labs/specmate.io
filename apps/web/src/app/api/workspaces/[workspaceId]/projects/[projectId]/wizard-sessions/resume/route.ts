import { NextResponse } from 'next/server';
import { requireProjectRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string }> };

// Connector setup is an ADMIN concern (Issue 5.3) — gated the same as every
// other connector-setup route (Issue #101).
export async function GET(request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;
  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const toolKey = new URL(request.url).searchParams.get('tool_key');
  if (!toolKey) {
    return NextResponse.json({ error: 'tool_key is required.' }, { status: 400 });
  }

  try {
    const response = await fetch(
      `${process.env.API_BASE_URL}/workspaces/${workspaceId}/projects/${projectId}/wizard-sessions/resume?tool_key=${encodeURIComponent(toolKey)}`,
    );
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Wizard service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
