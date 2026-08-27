import { NextResponse } from 'next/server';
import { requireProjectRole } from '@/lib/workspace-context';

interface FromConnectorBody {
  tool?: unknown;
  remote?: unknown;
}

// Add Source's "pull from a connected tool" option (Onboarding Flow redesign)
// — proxies to apps/api's materialize-backlog-as-Source endpoint, mirroring
// the shape of the file-upload route's apps/api parse-trigger call.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body = (await request.json().catch(() => ({}))) as FromConnectorBody;
  const { tool, remote } = body;
  if (typeof tool !== 'string' || typeof remote !== 'string' || !remote.trim()) {
    return NextResponse.json({ error: 'tool and remote are required strings.' }, { status: 400 });
  }

  try {
    const response = await fetch(
      `${process.env.API_BASE_URL}/projects/${projectId}/sources/from-connector/${encodeURIComponent(tool)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote }),
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
