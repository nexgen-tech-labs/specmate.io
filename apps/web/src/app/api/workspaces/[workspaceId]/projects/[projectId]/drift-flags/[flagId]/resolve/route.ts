import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireProjectRole } from '@/lib/workspace-context';

type Params = {
  params: Promise<{ workspaceId: string; projectId: string; flagId: string }>;
};

// Auth-gated proxy to apps/api's drift-flag resolve endpoint (Issue 9.5) — the
// browser never talks to apps/api directly (internal-only ingress; see architecture.md).
export async function POST(request: Request, { params }: Params) {
  const { workspaceId, projectId, flagId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  // Existence containment (matches the draft-item route convention): the flag must
  // actually belong to a PublishedItem in this project, not just any project.
  const flag = await prisma.driftFlag.findFirst({
    where: { id: flagId, publishedItem: { draftItem: { projectId } } },
  });
  if (!flag) {
    return NextResponse.json({ error: 'Drift flag not found.' }, { status: 404 });
  }

  const body: unknown = await request.json().catch(() => ({}));
  const session = await auth();
  try {
    const response = await fetch(`${process.env.API_BASE_URL}/drift-flags/${flagId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(typeof body === 'object' && body ? body : {}),
        resolved_by_user_id: session?.user?.id ?? null,
      }),
    });
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status });
  } catch {
    return NextResponse.json(
      { error: 'Drift service is unreachable — try again shortly.' },
      { status: 502 },
    );
  }
}
