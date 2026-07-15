import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireProjectRole } from '@/lib/workspace-context';
import { markGapResolved } from '@/lib/review';

type Params = { params: Promise<{ workspaceId: string; projectId: string; itemId: string }> };

// Gap resolution (Issue 4.6): either the reviewer answers the AI's question and the
// item is regenerated with that context (via apps/api, Issue 3.9), or they resolve it
// manually (typically after an inline edit). Both clear the gap flag; the audit trail
// distinguishes the two.
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

  const body = (await request.json()) as { resolution?: 'manual' | 'regenerate'; answer?: string };
  const actor = {
    actorUserId: access.membership.userId,
    actorRole: access.membership.role,
    workspaceId,
  };

  if (body.resolution === 'manual') {
    const result = await markGapResolved(itemId, 'manual', actor);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, item_id: itemId });
  }

  if (body.resolution === 'regenerate') {
    if (!body.answer?.trim()) {
      return NextResponse.json(
        { error: 'Answering the gap question requires an answer.' },
        { status: 400 },
      );
    }
    let regen: Response;
    try {
      regen = await fetch(`${process.env.API_BASE_URL}/draft-items/${itemId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: body.answer, workspace_id: workspaceId }),
      });
    } catch {
      return NextResponse.json(
        { error: 'Generation service is unreachable — try again shortly.' },
        { status: 502 },
      );
    }
    const regenBody = (await regen.json()) as { new_item_id?: string; detail?: string };
    if (!regen.ok || !regenBody.new_item_id) {
      return NextResponse.json(
        { error: regenBody.detail ?? 'Regeneration failed.' },
        { status: regen.status },
      );
    }
    // The regenerated revision inherits the flags — clear the now-answered gap on it.
    const result = await markGapResolved(regenBody.new_item_id, 'regenerated', actor);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, item_id: regenBody.new_item_id });
  }

  return NextResponse.json({ error: 'resolution must be manual or regenerate.' }, { status: 400 });
}
