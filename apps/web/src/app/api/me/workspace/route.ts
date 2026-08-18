import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// Resolves where to send a just-signed-in user — the sign-in modal has no
// workspace context of its own (unlike onboarding, which creates one and
// already knows the id), so it looks this up right after signIn() succeeds.
export async function GET(_request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'asc' },
    select: { workspaceId: true },
  });

  if (!membership) {
    return NextResponse.json({ workspaceId: null });
  }

  return NextResponse.json({ workspaceId: membership.workspaceId });
}
