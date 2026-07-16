import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { checkSeatGate } from '@/lib/billing-gate';

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const session = await auth();
  const userId = session?.user?.id;
  const userEmail = session?.user?.email;
  if (!userId || !userEmail) {
    return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
  }

  const invite = await prisma.workspaceInvite.findUnique({ where: { token } });
  if (!invite || invite.status !== 'PENDING' || invite.expiresAt < new Date()) {
    return NextResponse.json({ error: 'Invite is invalid or has expired.' }, { status: 404 });
  }
  if (invite.email !== userEmail) {
    return NextResponse.json(
      { error: 'This invite was sent to a different email address.' },
      { status: 403 },
    );
  }

  // Free-while-solo billing gate (Issue 10.9 amendment): accepting is the actual
  // moment a workspace becomes multi-user — enforced here, not at invite
  // creation (an admin can freely send invites that never get accepted).
  const seatGate = await checkSeatGate(invite.workspaceId, userId);
  if (!seatGate.allowed) {
    return NextResponse.json({ error: seatGate.reason, code: 'BILLING_REQUIRED' }, { status: 402 });
  }

  await prisma.$transaction([
    prisma.workspaceMember.create({
      data: { workspaceId: invite.workspaceId, userId, role: invite.role },
    }),
    prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { status: 'ACCEPTED' },
    }),
  ]);

  return NextResponse.json({ workspaceId: invite.workspaceId }, { status: 200 });
}
