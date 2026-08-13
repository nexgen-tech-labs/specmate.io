import { NextResponse } from 'next/server';
import { requireProjectRole } from '@/lib/workspace-context';

type Params = { params: Promise<{ workspaceId: string; projectId: string; toolKey: string }> };

// apps/api's per-tool health endpoints (/connectors/jira/health,
// /connectors/ado/health, /connectors/github/publish-health) are unscoped —
// they check the single-tenant env-configured connection, not anything
// workspace/project specific. GitHub's is named "publish-health" rather than
// "health" for historical reasons (Epic 5); normalize that here so the
// wizard's authenticate step can call one shape regardless of tool (Issue
// #101, Task 9). Gated the same as every other connector-setup route.
const UPSTREAM_PATH: Record<string, string> = {
  jira: '/connectors/jira/health',
  ado: '/connectors/ado/health',
  github: '/connectors/github/publish-health',
};

export async function GET(_request: Request, { params }: Params) {
  const { workspaceId, projectId, toolKey } = await params;
  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const upstreamPath = UPSTREAM_PATH[toolKey];
  if (!upstreamPath) {
    return NextResponse.json({ error: `Unknown connector '${toolKey}'.` }, { status: 404 });
  }

  try {
    const response = await fetch(`${process.env.API_BASE_URL}${upstreamPath}`);
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Connector service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
