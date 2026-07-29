import { NextResponse } from 'next/server';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { getWorkspaceUsageSummary } from '@/lib/usage';

type Params = { params: Promise<{ workspaceId: string }> };

// Programmatic usage monitoring (Issue 12.4 AC): same live-computed summary
// shown on the billing page, exposed as JSON for workspaces that want to poll
// it rather than check the UI.
export async function GET(_request: Request, { params }: Params) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const summary = await getWorkspaceUsageSummary(workspaceId);
  return NextResponse.json(summary);
}
