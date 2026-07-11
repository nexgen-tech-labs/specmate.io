import { NextResponse } from 'next/server';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { applyDecision, type DecisionAction } from '@/lib/review';

type Params = { params: Promise<{ workspaceId: string; projectId: string }> };

// Bulk is a UI convenience, not a data-model shortcut (Issue 4.9): each item goes
// through the same applyDecision path, producing per-item ReviewDecision + AuditEvent
// rows identical to individual actions.
export async function POST(request: Request, { params }: Params) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
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

  const results: Array<{ item_id: string; ok: boolean; error?: string }> = [];
  for (const itemId of body.item_ids) {
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
