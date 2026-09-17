import { NextResponse } from 'next/server';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import type { JobStatusPayload } from '@/lib/jobs';

type Params = { params: Promise<{ jobId: string }> };

// Auth-gated proxy to apps/api's job-status endpoint (internal-only
// ingress) — the browser polls this directly for long-running operations
// (the dashboard's Generate button) rather than the server-side awaitJob()
// helper, which is for routes that need to preserve a synchronous response
// shape for a fast operation. Unlike every OTHER workspace-scoped proxy
// route, the workspace/project id isn't in this URL — it's only knowable
// after fetching the job itself from apps/api — so the auth check happens
// AFTER that fetch, using the job's own workspace_id, rather than before.
export async function GET(_request: Request, { params }: Params) {
  const { jobId } = await params;

  let response: Response;
  try {
    response = await fetch(`${process.env.API_BASE_URL}/jobs/${jobId}`);
  } catch {
    return NextResponse.json(
      { error: 'Job status service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
  if (response.status === 404) {
    return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  }
  if (!response.ok) {
    return NextResponse.json({ error: 'Could not fetch job status.' }, { status: 502 });
  }
  const job = (await response.json()) as JobStatusPayload;

  const access = await requireWorkspaceRole(job.workspace_id, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  return NextResponse.json(job);
}
