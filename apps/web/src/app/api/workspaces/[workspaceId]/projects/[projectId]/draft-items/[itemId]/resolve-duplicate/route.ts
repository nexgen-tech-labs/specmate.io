import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireProjectRole } from '@/lib/workspace-context';
import { resolveDuplicate, type DuplicateResolution } from '@/lib/review';

type Params = { params: Promise<{ workspaceId: string; projectId: string; itemId: string }> };

const RESOLUTIONS: DuplicateResolution[] = ['confirm', 'merge', 'override'];

export async function POST(request: Request, { params }: Params) {
  const { workspaceId, projectId, itemId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  // Team-scope containment (Issue 12.11): the item must belong to the project in
  // the URL — prevents a team-scoped member reaching an out-of-scope item via an
  // in-scope project's URL (the review lib only checks the workspace boundary).
  const item = await prisma.draftItem.findFirst({
    where: { id: itemId, projectId },
    select: { id: true },
  });
  if (!item) return NextResponse.json({ error: 'Item not found.' }, { status: 404 });

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
