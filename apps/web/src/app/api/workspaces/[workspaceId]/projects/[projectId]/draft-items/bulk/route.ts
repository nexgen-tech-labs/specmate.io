import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireProjectRole } from '@/lib/workspace-context';
import { applyDecision, type DecisionAction } from '@/lib/review';

type Params = { params: Promise<{ workspaceId: string; projectId: string }> };

// Bulk is a UI convenience, not a data-model shortcut (Issue 4.9): each item goes
// through the same applyDecision path, producing per-item ReviewDecision + AuditEvent
// rows identical to individual actions.
export async function POST(request: Request, { params }: Params) {
  const { workspaceId, projectId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body = (await request.json()) as {
    item_ids?: string[];
    action?: DecisionAction;
    reason?: string;
  };
  if (!Array.isArray(body.item_ids) || body.item_ids.length === 0) {
    return NextResponse.json({ error: 'item_ids is required.' }, { status: 400 });
  }
  if (body.action !== 'approve' && body.action !== 'reject') {
    return NextResponse.json({ error: 'Bulk supports approve or reject.' }, { status: 400 });
  }

  // Team-scope containment (Issue 12.11): only items in the URL's project are
  // processed — out-of-project ids fail per-item instead of failing the batch.
  const inProject = new Set(
    (
      await prisma.draftItem.findMany({
        where: { id: { in: body.item_ids }, projectId },
        select: { id: true },
      })
    ).map((i) => i.id),
  );

  const results: Array<{ item_id: string; ok: boolean; error?: string }> = [];
  for (const itemId of body.item_ids) {
    if (!inProject.has(itemId)) {
      results.push({ item_id: itemId, ok: false, error: 'Item not found in this project.' });
      continue;
    }
    const result = await applyDecision(itemId, {
      action: body.action,
      reason: body.reason,
      actorUserId: access.membership.userId,
      actorRole: access.membership.role,
      workspaceId,
    });
    results.push({ item_id: itemId, ok: result.ok, error: result.error });
  }
  return NextResponse.json({
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
}
