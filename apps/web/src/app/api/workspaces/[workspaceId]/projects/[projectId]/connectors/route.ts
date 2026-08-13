import { NextResponse } from 'next/server';
import { requireProjectRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string }> };

// apps/api's GET /connectors is tool-agnostic static registry data with no
// workspace/project scoping of its own. There's no unscoped-auth precedent
// elsewhere in this codebase's proxy routes (every existing route gates on
// requireProjectRole), so rather than invent a new bare-session-only pattern
// for this one route, this route lives under the usual
// /workspaces/{workspaceId}/projects/{projectId} path and gates on project
// ADMIN like every other connector-setup route — even though the upstream
// call itself ignores workspaceId/projectId (Issue #101, Task 9).
export async function GET(_request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;
  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  try {
    const response = await fetch(`${process.env.API_BASE_URL}/connectors`);
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Connector service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
