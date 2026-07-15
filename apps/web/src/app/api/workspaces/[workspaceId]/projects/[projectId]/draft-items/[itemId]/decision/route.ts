import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireProjectRole } from '@/lib/workspace-context';
import { applyDecision, type DecisionAction, type EditPayload } from '@/lib/review';

type Params = { params: Promise<{ workspaceId: string; projectId: string; itemId: string }> };

const ACTIONS: DecisionAction[] = ['approve', 'reject', 'edit', 'signoff', 'reopen'];

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
