import { NextResponse } from 'next/server';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { resolveDuplicate, type DuplicateResolution } from '@/lib/review';

type Params = { params: Promise<{ workspaceId: string; projectId: string; itemId: string }> };

const RESOLUTIONS: DuplicateResolution[] = ['confirm', 'merge', 'override'];

export async function POST(request: Request, { params }: Params) {
  const { workspaceId, itemId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body = (await request.json()) as { resolution?: DuplicateResolution };
  if (!body.resolution || !RESOLUTIONS.includes(body.resolution)) {
    return NextResponse.json(
      { error: 'resolution must be confirm, merge, or override.' },
      { status: 400 },
    );
  }

  const result = await resolveDuplicate(itemId, body.resolution, {
    actorUserId: access.membership.userId,
    actorRole: access.membership.role,
    workspaceId,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
