import { NextResponse } from 'next/server';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { applyDecision, type DecisionAction, type EditPayload } from '@/lib/review';

type Params = { params: Promise<{ workspaceId: string; projectId: string; itemId: string }> };

const ACTIONS: DecisionAction[] = ['approve', 'reject', 'edit', 'signoff', 'reopen'];

export async function POST(request: Request, { params }: Params) {
  const { workspaceId, itemId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const body = (await request.json()) as {
    action?: DecisionAction;
    reason?: string;
    edits?: EditPayload;
  };
  if (!body.action || !ACTIONS.includes(body.action)) {
    return NextResponse.json({ error: 'Invalid action.' }, { status: 400 });
  }

  const result = await applyDecision(itemId, {
    action: body.action,
    reason: body.reason,
    edits: body.edits,
    actorUserId: access.membership.userId,
    actorRole: access.membership.role,
    workspaceId,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
